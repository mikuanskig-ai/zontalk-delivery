-- ============================================================
-- 086_admin_account_deletion.sql — "Excluir empresa" audit trail.
--
-- Eder, 2026-09-22: the accounts table's Ações menu gets a real delete
-- (every account_id-scoped table already cascades off accounts(id) —
-- confirmed across every migration, so DELETE FROM accounts is a clean
-- cut, no orphaned rows).
--
-- `admin_account_deletion_log` records who deleted which company, and
-- deliberately carries NO foreign key to `accounts` — by definition
-- the account is gone by the time this is useful to read, so an FK
-- would either block the delete or (with CASCADE) erase the very
-- record meant to survive it. RLS is enabled with NO policies, same
-- as admin_login_as_log (085): only the service-role delete route
-- reads or writes this.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_account_deletion_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id      UUID NOT NULL,
  deleted_account_id UUID NOT NULL,
  account_name       TEXT NOT NULL,
  owner_email        TEXT,
  deleted_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admin_account_deletion_log ENABLE ROW LEVEL SECURITY;
