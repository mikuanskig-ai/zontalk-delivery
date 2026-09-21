-- ============================================================
-- 085_login_as_audit.sql — "Acessar empresa" becomes a real login.
--
-- Until now (migration 080) the platform admin stayed logged in as
-- themselves and was GRANTED access to the target company through
-- `admin_impersonation_sessions`. From v0.35.0 the admin is logged in
-- AS the company's own admin user (its owner), so the grant path is no
-- longer used. Two things here:
--
--   1. `admin_login_as_log` — the audit trail. Inside the company the
--      admin is indistinguishable from the real user, so who entered
--      which account, and when, is recorded here. RLS is enabled with
--      NO policies on purpose: only the service role (the two
--      impersonation routes) can read or write it.
--
--   2. Close any still-open 080 grant. `is_account_member` (migration
--      080) keeps honoring an unexpired grant for its admin_user_id, so
--      a leftover row would silently keep granting that admin access
--      to the target account from their OWN session. New starts don't
--      create grants; this just retires the old ones.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_login_as_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id      UUID NOT NULL,
  target_user_id     UUID NOT NULL,
  target_account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_login_as_log_account
  ON admin_login_as_log(target_account_id, started_at DESC);

ALTER TABLE admin_login_as_log ENABLE ROW LEVEL SECURITY;

UPDATE admin_impersonation_sessions
   SET ended_at = now()
 WHERE ended_at IS NULL;
