-- ============================================================
-- 080_admin_impersonation.sql — "Acessar Empresa" (platform-admin
-- login-as-tenant), migration 062's admin panel expansion
--
-- Pedido do Eder: no `/admin` (aba Empresas), o platform admin poder
-- entrar no painel de uma empresa "como se fosse um usuário dela" —
-- sem senha, sem virar membro permanente daquela conta.
--
-- Why this needs its own table instead of just tweaking `profiles`:
-- migration 017 made tenancy strictly one-account-per-user
-- (`profiles.account_id`/`account_role`, single row) — every RLS
-- policy in this schema, and both identity seams the app code funnels
-- through (`getCurrentAccount()` server-side, `useAuth()`
-- client-side), resolve "which account am I in" from that one row.
-- Temporarily overwriting the admin's own `profiles` row would work
-- but is destructive/racy (their real account context is gone until
-- some cleanup job restores it — a crash mid-session strands them out
-- of their own account) and leaves no natural expiry.
--
-- Instead: a short-lived, revocable GRANT row. `is_account_member` —
-- the single choke point every table's RLS already calls through
-- (see 017's own doc comment) — now also recognizes a platform admin
-- with a live, unexpired grant for the target account, in addition to
-- its normal profiles-row membership check. This means every existing
-- RLS policy in the whole schema honors impersonation for free, with
-- zero changes to any of them.
--
-- `resolveAccountContext()` (src/lib/auth/account.ts) and `useAuth()`
-- (src/hooks/use-auth.tsx) are the two remaining seams — updated in
-- the same commit as this migration to prefer an active grant over
-- the admin's own profile row when both exist, so every page (not
-- just RLS-gated queries) shows the target account's own data.
--
-- Safety rails: one active grant per admin at a time (starting a new
-- one ends any previous one — see the API route), a hard 60-minute
-- expiry, always full ('owner') access rather than a partial role
-- (this is a support tool, not a permissions experiment), and the
-- grant row itself doubles as the audit trail (who accessed which
-- account, when, for how long) — no separate audit table needed for
-- a v1 this narrow.
--
-- Known limitation, not solved here: storage buckets (avatars,
-- flow-media) are user-scoped, not account-scoped (per 017) — an
-- impersonating admin may not be able to read/write the target
-- account's per-user storage objects. Flag for a follow-up if this
-- ever actually blocks a support session.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_impersonation_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_role       account_role_enum NOT NULL DEFAULT 'owner',
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  ended_at          timestamptz
);

-- The "do I have a live grant right now" lookup (is_account_member,
-- the client's own session check) filters on exactly these three
-- columns every time.
CREATE INDEX IF NOT EXISTS admin_impersonation_sessions_active_idx
  ON admin_impersonation_sessions (admin_user_id, target_account_id, expires_at)
  WHERE ended_at IS NULL;

ALTER TABLE admin_impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- The admin may read their own grant rows — needed for the client-side
-- "you are viewing X as if logged in" banner and its exit button.
-- Everything else (creating, ending) goes through the API routes on
-- the service-role client (requirePlatformAdmin already gates those);
-- `authenticated` gets no INSERT/UPDATE/DELETE policy at all here, so
-- a tenant (or the admin acting as a plain PostgREST caller) can never
-- grant themselves cross-tenant access directly.
DROP POLICY IF EXISTS admin_impersonation_sessions_select ON admin_impersonation_sessions;
CREATE POLICY admin_impersonation_sessions_select ON admin_impersonation_sessions FOR SELECT
  USING (admin_user_id = auth.uid());

-- Extends the 017 helper with a second, independent grant path. Same
-- role-rank CASE as before, now checked against EITHER the caller's
-- own account membership OR a live impersonation grant for that exact
-- account. SECURITY DEFINER (already was) — the EXISTS below reads
-- admin_impersonation_sessions across all rows regardless of the
-- caller's own SELECT policy, mirroring how it already reads all of
-- `profiles` that way.
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END >= CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  )
  OR EXISTS (
    SELECT 1
    FROM admin_impersonation_sessions s
    WHERE s.admin_user_id = auth.uid()
      AND s.target_account_id = target_account_id
      AND s.ended_at IS NULL
      AND s.expires_at > now()
      AND CASE s.target_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END >= CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;
