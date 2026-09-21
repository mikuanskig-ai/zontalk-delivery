-- ============================================================
-- 084_ai_followup_autoclose.sql — AI follow-up + automatic close.
--
--   1. Follow-up: when a customer starts an order with the AI (cart
--      has items) and then goes silent, the AI sends a personalisable
--      nudge after N minutes (up to `followup_max` times). If they
--      still never answer, the ticket is closed after
--      `followup_close_minutes`.
--   2. Auto-close after order: N minutes after an order is placed (and
--      after the customer's last message) the ticket is sent to
--      Fechados — `auto_close_after_order_minutes`, NULL = off.
--
-- Everything is opt-in per account (followup_enabled defaults false,
-- auto-close defaults NULL = off), so deploying this changes nothing
-- until an admin turns it on in Agentes de IA → Configuração.
--
-- Per-conversation bookkeeping lives on `conversations`:
--   ai_followup_count / ai_followup_at — how many nudges were sent and
--     when; reset when the customer writes again.
--   ai_close_at — when the post-order auto-close is due; pushed back
--     every time the customer writes, cleared if a human takes over.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS followup_delay_minutes integer NOT NULL DEFAULT 20
    CHECK (followup_delay_minutes BETWEEN 5 AND 720),
  ADD COLUMN IF NOT EXISTS followup_max integer NOT NULL DEFAULT 1
    CHECK (followup_max BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS followup_messages jsonb,
  ADD COLUMN IF NOT EXISTS followup_close_minutes integer NOT NULL DEFAULT 120
    CHECK (followup_close_minutes BETWEEN 0 AND 1440),
  ADD COLUMN IF NOT EXISTS auto_close_after_order_minutes integer
    CHECK (auto_close_after_order_minutes IS NULL OR auto_close_after_order_minutes BETWEEN 1 AND 720);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_followup_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_followup_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_close_at timestamptz;

-- The sweep looks up "due" auto-closes; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_close_at
  ON conversations(ai_close_at)
  WHERE ai_close_at IS NOT NULL;
