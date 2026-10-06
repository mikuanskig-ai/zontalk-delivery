-- ============================================================
-- 087_ai_followup_events.sql — an audit trail of what the AI follow-up
-- actually did, per conversation: each nudge sent (or failed to send)
-- and each conversation auto-closed for silence.
--
-- Written only by the cron sweep (service role). Read by admins+ on the
-- Agentes de IA → Follow-up tab. "Entregue" is deliberately not a
-- column: the WhatsApp gateway here reports acceptance (`sent`) and
-- never delivery receipts for bot messages, so the honest state is
-- sent vs failed, plus whether the customer answered afterwards.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_followup_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('nudge', 'close_no_reply')),
  step            SMALLINT,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error           TEXT,
  message_text    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_followup_events_account
  ON ai_followup_events(account_id, created_at DESC);

ALTER TABLE ai_followup_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_followup_events_select ON ai_followup_events
  FOR SELECT USING (is_account_member(account_id, 'admin'));
