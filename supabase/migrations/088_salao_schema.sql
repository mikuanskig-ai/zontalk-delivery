-- ============================================================
-- 088_salao_schema.sql — módulo Salão (mesas, comandas, garçom, caixa).
--
-- Gated por `salao` em accounts.enabled_modules (migration 041).
--
-- Quem escreve: SÓ as rotas /api/salao/* com o cliente de serviço. O
-- garçom não é usuário do Supabase (entra por aparelho conectado + PIN),
-- então não existe policy de INSERT/UPDATE/DELETE para sessões comuns —
-- a autorização (aparelho, PIN, permissão configurável) é feita no
-- código das rotas. As policies abaixo são só de LEITURA, para o painel
-- do dono (relatórios, configurações).
--
-- As operações que mexem em mais de uma linha e precisam ser atômicas
-- (lançar rodada, cancelar item, transferir/juntar mesa, fechar comanda
-- com pagamentos, fechar caixa) são funções SQL chamadas só pelo
-- servidor (EXECUTE só para service_role).
--
-- Quem fez cada ação fica em `*_by_staff_id` (pode ficar NULL se o
-- funcionário for apagado ou se foi o dono logado no painel) + `*_by_name`
-- (nome congelado na hora, para o histórico não perder o autor).
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- CONFIGURAÇÕES DO SALÃO (uma linha por conta)
-- ============================================================
CREATE TABLE IF NOT EXISTS salao_settings (
  account_id            UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  service_fee_percent   NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (service_fee_percent >= 0 AND service_fee_percent <= 100),
  service_fee_default_on BOOLEAN NOT NULL DEFAULT true,
  require_open_cash     BOOLEAN NOT NULL DEFAULT true,
  -- Só as diferenças em relação ao padrão do código:
  -- { "garcom": { "close_tab": true }, "caixa": { "cancel_item": false } }
  permissions           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MESAS
-- ============================================================
CREATE TABLE IF NOT EXISTS salao_tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL CHECK (number > 0),
  name        TEXT,
  area        TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  -- Vai dentro do QR (/m/<qr_token>). 122 bits aleatórios; trocar o
  -- valor invalida o QR impresso antigo.
  qr_token    TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, number)
);

CREATE INDEX IF NOT EXISTS idx_salao_tables_account ON salao_tables(account_id, position, number);

-- ============================================================
-- EQUIPE (garçom / caixa / gerente) — identificada por PIN
-- ============================================================
CREATE TABLE IF NOT EXISTS salao_staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('garcom', 'caixa', 'gerente')),
  -- HMAC-SHA256(PIN) com segredo do servidor: determinístico (dá para
  -- exigir PIN único por conta e achar o funcionário pelo PIN), mas um
  -- vazamento só do banco não permite adivinhar PINs de 4-6 dígitos.
  pin_hmac    TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_salao_staff_pin ON salao_staff(account_id, pin_hmac) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_salao_staff_account ON salao_staff(account_id);

-- ============================================================
-- APARELHOS CONECTADOS + CÓDIGOS DE PAREAMENTO
-- ============================================================
CREATE TABLE IF NOT EXISTS salao_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_salao_devices_account ON salao_devices(account_id);

CREATE TABLE IF NOT EXISTS salao_pairing_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hmac    TEXT NOT NULL,
  device_name  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salao_pairing_codes_code ON salao_pairing_codes(code_hmac) WHERE used_at IS NULL;

-- ============================================================
-- CAIXA DO DIA
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_float      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  opened_by_staff_id UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  opened_by_name     TEXT NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by_staff_id UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  closed_by_name     TEXT,
  closed_at          TIMESTAMPTZ,
  counted_cash       NUMERIC(12,2),
  expected_cash      NUMERIC(12,2),
  difference         NUMERIC(12,2),
  notes              TEXT
);

-- Só pode haver um caixa aberto por conta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_sessions_one_open ON cash_sessions(account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cash_sessions_account ON cash_sessions(account_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS cash_movements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cash_session_id  UUID NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('withdrawal', 'supply')),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason           TEXT,
  by_staff_id      UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  by_name          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id);

-- ============================================================
-- COMANDAS
-- ============================================================
CREATE TABLE IF NOT EXISTS salao_tabs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = venda de balcão (comanda sem mesa).
  table_id              UUID REFERENCES salao_tables(id) ON DELETE SET NULL,
  label                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'bill_requested', 'closed', 'cancelled')),
  guests                INTEGER NOT NULL DEFAULT 1 CHECK (guests > 0),
  customer_name         TEXT,
  opened_by_staff_id    UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  opened_by_name        TEXT NOT NULL,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  bill_requested_at     TIMESTAMPTZ,
  closed_by_staff_id    UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  closed_by_name        TEXT,
  closed_at             TIMESTAMPTZ,
  cash_session_id       UUID REFERENCES cash_sessions(id) ON DELETE SET NULL,
  merged_into_tab_id    UUID REFERENCES salao_tabs(id) ON DELETE SET NULL,
  service_fee_enabled   BOOLEAN NOT NULL DEFAULT true,
  service_fee_percent   NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_amount       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  subtotal              NUMERIC(12,2) NOT NULL DEFAULT 0,
  service_fee_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma comanda aberta por mesa (a corrida de dois garçons abrindo a
-- mesma mesa ao mesmo tempo é decidida aqui, não no código).
CREATE UNIQUE INDEX IF NOT EXISTS uq_salao_tabs_one_open_per_table
  ON salao_tabs(table_id) WHERE table_id IS NOT NULL AND status IN ('open', 'bill_requested');
CREATE INDEX IF NOT EXISTS idx_salao_tabs_account_status ON salao_tabs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_salao_tabs_account_closed ON salao_tabs(account_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_salao_tabs_updated ON salao_tabs(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS salao_rounds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tab_id              UUID NOT NULL REFERENCES salao_tabs(id) ON DELETE CASCADE,
  number              INTEGER NOT NULL,
  sent_by_staff_id    UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  sent_by_name        TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salao_rounds_tab ON salao_rounds(tab_id);

CREATE TABLE IF NOT EXISTS salao_tab_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tab_id            UUID NOT NULL REFERENCES salao_tabs(id) ON DELETE CASCADE,
  round_id          UUID NOT NULL REFERENCES salao_rounds(id) ON DELETE CASCADE,
  product_id        UUID REFERENCES delivery_products(id) ON DELETE SET NULL,
  product_name      TEXT NOT NULL,
  unit_price        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  addons_snapshot   JSONB NOT NULL DEFAULT '[]'::jsonb,
  line_total        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_reason  TEXT,
  cancelled_by_staff_id UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  cancelled_by_name TEXT,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salao_tab_items_tab ON salao_tab_items(tab_id);
CREATE INDEX IF NOT EXISTS idx_salao_tab_items_round ON salao_tab_items(round_id);

CREATE TABLE IF NOT EXISTS salao_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tab_id             UUID NOT NULL REFERENCES salao_tabs(id) ON DELETE CASCADE,
  method             TEXT NOT NULL CHECK (method IN ('pix', 'credit', 'debit', 'cash', 'other')),
  -- Quanto da conta esta forma de pagamento quitou (nunca inclui troco).
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  -- Só para dinheiro: quanto o cliente entregou, e o troco devolvido.
  tendered           NUMERIC(12,2),
  change_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  received_by_staff_id UUID REFERENCES salao_staff(id) ON DELETE SET NULL,
  received_by_name   TEXT NOT NULL,
  cash_session_id    UUID REFERENCES cash_sessions(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_salao_payments_tab ON salao_payments(tab_id);
CREATE INDEX IF NOT EXISTS idx_salao_payments_session ON salao_payments(cash_session_id);

-- ============================================================
-- updated_at
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at ON salao_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON salao_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON salao_tables;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON salao_tables FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON salao_staff;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON salao_staff FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON salao_tabs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON salao_tabs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS — só leitura para o painel; escrita só pelo servidor.
-- Dados sensíveis (PIN/aparelhos/códigos/configurações) só admin+.
-- ============================================================
ALTER TABLE salao_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_tables          ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_staff           ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_devices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_pairing_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_tabs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_rounds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_tab_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE salao_payments        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS salao_settings_select ON salao_settings;
CREATE POLICY salao_settings_select ON salao_settings FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS salao_tables_select ON salao_tables;
CREATE POLICY salao_tables_select ON salao_tables FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS salao_staff_select ON salao_staff;
CREATE POLICY salao_staff_select ON salao_staff FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS salao_devices_select ON salao_devices;
CREATE POLICY salao_devices_select ON salao_devices FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS salao_pairing_codes_select ON salao_pairing_codes;
CREATE POLICY salao_pairing_codes_select ON salao_pairing_codes FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS cash_sessions_select ON cash_sessions;
CREATE POLICY cash_sessions_select ON cash_sessions FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS cash_movements_select ON cash_movements;
CREATE POLICY cash_movements_select ON cash_movements FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS salao_tabs_select ON salao_tabs;
CREATE POLICY salao_tabs_select ON salao_tabs FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS salao_rounds_select ON salao_rounds;
CREATE POLICY salao_rounds_select ON salao_rounds FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS salao_tab_items_select ON salao_tab_items;
CREATE POLICY salao_tab_items_select ON salao_tab_items FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS salao_payments_select ON salao_payments;
CREATE POLICY salao_payments_select ON salao_payments FOR SELECT USING (is_account_member(account_id));

-- ============================================================
-- FUNÇÕES ATÔMICAS (chamadas só pelo servidor)
-- Erros de regra de negócio usam RAISE EXCEPTION com um código curto na
-- mensagem (ex.: 'tab_not_open'); o servidor traduz para a resposta.
-- ============================================================

-- Recalcula subtotal / taxa de serviço / total de uma comanda a partir
-- dos itens ativos. Chamada por todas as funções abaixo e pelas rotas
-- que mudam taxa ou desconto.
CREATE OR REPLACE FUNCTION salao_recalc_tab(p_tab UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  t salao_tabs%ROWTYPE;
  v_sub NUMERIC(12,2);
  v_fee NUMERIC(12,2);
BEGIN
  SELECT * INTO t FROM salao_tabs WHERE id = p_tab;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_sub
  FROM salao_tab_items WHERE tab_id = p_tab AND status = 'active';

  v_fee := CASE WHEN t.service_fee_enabled THEN round(v_sub * t.service_fee_percent / 100, 2) ELSE 0 END;

  UPDATE salao_tabs
  SET subtotal = v_sub,
      service_fee_amount = v_fee,
      total = GREATEST(0, v_sub + v_fee - t.discount_amount)
  WHERE id = p_tab;
END;
$function$;

-- Lança uma rodada de itens (já validados e com preço calculado pelo
-- servidor) numa comanda aberta. p_items: array de
-- { product_id, product_name, unit_price, quantity, addons_snapshot, line_total, notes }.
CREATE OR REPLACE FUNCTION salao_add_round(
  p_account_id UUID,
  p_tab_id UUID,
  p_staff_id UUID,
  p_staff_name TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  t salao_tabs%ROWTYPE;
  v_round_id UUID;
  v_number INTEGER;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'no_items';
  END IF;

  SELECT * INTO t FROM salao_tabs WHERE id = p_tab_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tab_not_found'; END IF;
  IF t.status NOT IN ('open', 'bill_requested') THEN RAISE EXCEPTION 'tab_not_open'; END IF;

  SELECT COALESCE(MAX(number), 0) + 1 INTO v_number FROM salao_rounds WHERE tab_id = p_tab_id;

  INSERT INTO salao_rounds (account_id, tab_id, number, sent_by_staff_id, sent_by_name)
  VALUES (p_account_id, p_tab_id, v_number, p_staff_id, p_staff_name)
  RETURNING id INTO v_round_id;

  INSERT INTO salao_tab_items (
    account_id, tab_id, round_id, product_id, product_name,
    unit_price, quantity, addons_snapshot, line_total, notes
  )
  SELECT
    p_account_id, p_tab_id, v_round_id,
    NULLIF(i->>'product_id', '')::uuid,
    i->>'product_name',
    (i->>'unit_price')::numeric,
    (i->>'quantity')::integer,
    COALESCE(i->'addons_snapshot', '[]'::jsonb),
    (i->>'line_total')::numeric,
    NULLIF(i->>'notes', '')
  FROM jsonb_array_elements(p_items) AS i;

  -- Pedir mais depois da conta: a comanda volta a ficar "aberta".
  UPDATE salao_tabs SET status = 'open', bill_requested_at = NULL WHERE id = p_tab_id;
  PERFORM salao_recalc_tab(p_tab_id);

  RETURN jsonb_build_object('round_id', v_round_id, 'round_number', v_number);
END;
$function$;

-- Cancela um item já lançado (o servidor já checou a permissão).
CREATE OR REPLACE FUNCTION salao_cancel_item(
  p_account_id UUID,
  p_item_id UUID,
  p_staff_id UUID,
  p_staff_name TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  it salao_tab_items%ROWTYPE;
  t salao_tabs%ROWTYPE;
BEGIN
  SELECT * INTO it FROM salao_tab_items WHERE id = p_item_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF it.status = 'cancelled' THEN RAISE EXCEPTION 'item_already_cancelled'; END IF;

  SELECT * INTO t FROM salao_tabs WHERE id = it.tab_id FOR UPDATE;
  IF t.status NOT IN ('open', 'bill_requested') THEN RAISE EXCEPTION 'tab_not_open'; END IF;

  UPDATE salao_tab_items
  SET status = 'cancelled',
      cancelled_reason = p_reason,
      cancelled_by_staff_id = p_staff_id,
      cancelled_by_name = p_staff_name,
      cancelled_at = now()
  WHERE id = p_item_id;

  PERFORM salao_recalc_tab(it.tab_id);

  RETURN jsonb_build_object('tab_id', it.tab_id, 'item_id', p_item_id);
END;
$function$;

-- Muda a comanda de mesa. Se a mesa de destino já tem comanda aberta,
-- JUNTA: itens e rodadas passam para a comanda de destino e a de origem
-- vira 'cancelled' (apontando para onde foi, em merged_into_tab_id).
CREATE OR REPLACE FUNCTION salao_transfer_tab(
  p_account_id UUID,
  p_tab_id UUID,
  p_to_table_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  src salao_tabs%ROWTYPE;
  dst salao_tabs%ROWTYPE;
  v_table salao_tables%ROWTYPE;
BEGIN
  SELECT * INTO src FROM salao_tabs WHERE id = p_tab_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tab_not_found'; END IF;
  IF src.status NOT IN ('open', 'bill_requested') THEN RAISE EXCEPTION 'tab_not_open'; END IF;

  SELECT * INTO v_table FROM salao_tables WHERE id = p_to_table_id AND account_id = p_account_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'table_not_found'; END IF;
  IF src.table_id IS NOT DISTINCT FROM p_to_table_id THEN RAISE EXCEPTION 'same_table'; END IF;

  SELECT * INTO dst FROM salao_tabs
  WHERE table_id = p_to_table_id AND status IN ('open', 'bill_requested') FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE salao_tabs
    SET table_id = p_to_table_id, label = 'Mesa ' || v_table.number
    WHERE id = p_tab_id;
    RETURN jsonb_build_object('tab_id', p_tab_id, 'merged', false);
  END IF;

  UPDATE salao_rounds SET tab_id = dst.id WHERE tab_id = src.id;
  UPDATE salao_tab_items SET tab_id = dst.id WHERE tab_id = src.id;
  UPDATE salao_tabs
  SET status = 'cancelled', table_id = NULL, merged_into_tab_id = dst.id,
      closed_at = now(), subtotal = 0, service_fee_amount = 0, total = 0
  WHERE id = src.id;
  UPDATE salao_tabs
  SET status = 'open', bill_requested_at = NULL, guests = dst.guests + src.guests
  WHERE id = dst.id;
  PERFORM salao_recalc_tab(dst.id);

  RETURN jsonb_build_object('tab_id', dst.id, 'merged', true);
END;
$function$;

-- Fecha a comanda registrando os pagamentos. p_payments: array de
-- { method, amount, tendered? }. A soma dos `amount` tem que bater com
-- o total da comanda (centavos).
CREATE OR REPLACE FUNCTION salao_close_tab(
  p_account_id UUID,
  p_tab_id UUID,
  p_staff_id UUID,
  p_staff_name TEXT,
  p_payments JSONB,
  p_cash_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  t salao_tabs%ROWTYPE;
  v_paid NUMERIC(12,2);
BEGIN
  SELECT * INTO t FROM salao_tabs WHERE id = p_tab_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tab_not_found'; END IF;
  IF t.status NOT IN ('open', 'bill_requested') THEN RAISE EXCEPTION 'tab_not_open'; END IF;

  PERFORM salao_recalc_tab(p_tab_id);
  SELECT * INTO t FROM salao_tabs WHERE id = p_tab_id;

  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' THEN
    p_payments := '[]'::jsonb;
  END IF;

  SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_paid FROM jsonb_array_elements(p_payments) AS p;
  IF abs(v_paid - t.total) > 0.005 THEN RAISE EXCEPTION 'payments_mismatch'; END IF;

  INSERT INTO salao_payments (
    account_id, tab_id, method, amount, tendered, change_amount,
    received_by_staff_id, received_by_name, cash_session_id
  )
  SELECT
    p_account_id, p_tab_id,
    p->>'method',
    (p->>'amount')::numeric,
    CASE WHEN p->>'method' = 'cash' THEN NULLIF(p->>'tendered', '')::numeric END,
    CASE WHEN p->>'method' = 'cash' AND NULLIF(p->>'tendered', '') IS NOT NULL
         THEN GREATEST(0, (p->>'tendered')::numeric - (p->>'amount')::numeric) ELSE 0 END,
    p_staff_id, p_staff_name, p_cash_session_id
  FROM jsonb_array_elements(p_payments) AS p
  WHERE (p->>'amount')::numeric > 0;

  UPDATE salao_tabs
  SET status = 'closed', closed_at = now(),
      closed_by_staff_id = p_staff_id, closed_by_name = p_staff_name,
      cash_session_id = p_cash_session_id
  WHERE id = p_tab_id;

  RETURN jsonb_build_object('tab_id', p_tab_id, 'total', t.total);
END;
$function$;

-- Reabre uma comanda fechada (só gerente — o servidor checa). Apaga os
-- pagamentos dela. Se ela foi paga num caixa que já fechou, NÃO reabre:
-- mexer num caixa fechado bagunçaria o relatório já conferido.
CREATE OR REPLACE FUNCTION salao_reopen_tab(
  p_account_id UUID,
  p_tab_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  t salao_tabs%ROWTYPE;
  v_session_status TEXT;
BEGIN
  SELECT * INTO t FROM salao_tabs WHERE id = p_tab_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tab_not_found'; END IF;
  IF t.status <> 'closed' THEN RAISE EXCEPTION 'tab_not_closed'; END IF;

  IF t.cash_session_id IS NOT NULL THEN
    SELECT status INTO v_session_status FROM cash_sessions WHERE id = t.cash_session_id;
    IF v_session_status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'cash_session_closed'; END IF;
  END IF;

  -- A mesa pode ter sido ocupada de novo depois do fechamento.
  IF t.table_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM salao_tabs
    WHERE table_id = t.table_id AND status IN ('open', 'bill_requested') AND id <> t.id
  ) THEN
    RAISE EXCEPTION 'table_busy';
  END IF;

  DELETE FROM salao_payments WHERE tab_id = p_tab_id;
  UPDATE salao_tabs
  SET status = 'open', closed_at = NULL, closed_by_staff_id = NULL, closed_by_name = NULL,
      cash_session_id = NULL, bill_requested_at = NULL
  WHERE id = p_tab_id;

  RETURN jsonb_build_object('tab_id', p_tab_id);
END;
$function$;

-- Fecha o caixa do dia: calcula o dinheiro esperado (fundo + dinheiro
-- recebido no salão + suprimentos − sangrias) e guarda a diferença para
-- o valor contado. Pedidos de delivery NÃO entram no esperado (a forma
-- de pagamento deles é texto livre e o dinheiro fica com o entregador).
CREATE OR REPLACE FUNCTION salao_close_cash_session(
  p_account_id UUID,
  p_session_id UUID,
  p_staff_id UUID,
  p_staff_name TEXT,
  p_counted NUMERIC,
  p_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  s cash_sessions%ROWTYPE;
  v_cash NUMERIC(12,2);
  v_supply NUMERIC(12,2);
  v_withdrawal NUMERIC(12,2);
  v_expected NUMERIC(12,2);
BEGIN
  IF p_counted IS NULL OR p_counted < 0 THEN RAISE EXCEPTION 'invalid_counted'; END IF;

  SELECT * INTO s FROM cash_sessions WHERE id = p_session_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'session_not_open'; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM salao_payments WHERE cash_session_id = p_session_id AND method = 'cash';
  SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'supply'), 0),
         COALESCE(SUM(amount) FILTER (WHERE kind = 'withdrawal'), 0)
  INTO v_supply, v_withdrawal
  FROM cash_movements WHERE cash_session_id = p_session_id;

  v_expected := s.opening_float + v_cash + v_supply - v_withdrawal;

  UPDATE cash_sessions
  SET status = 'closed', closed_at = now(),
      closed_by_staff_id = p_staff_id, closed_by_name = p_staff_name,
      counted_cash = p_counted, expected_cash = v_expected,
      difference = p_counted - v_expected, notes = p_notes
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'expected_cash', v_expected,
    'counted_cash', p_counted,
    'difference', p_counted - v_expected
  );
END;
$function$;

-- Só o servidor (service_role) executa. O Supabase concede EXECUTE a
-- anon/authenticated por padrão em funções novas — retiramos de forma
-- explícita, como nas migrations 007 e 012.
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'salao_recalc_tab(uuid)',
    'salao_add_round(uuid, uuid, uuid, text, jsonb)',
    'salao_cancel_item(uuid, uuid, uuid, text, text)',
    'salao_transfer_tab(uuid, uuid, uuid)',
    'salao_close_tab(uuid, uuid, uuid, text, jsonb, uuid)',
    'salao_reopen_tab(uuid, uuid)',
    'salao_close_cash_session(uuid, uuid, uuid, text, numeric, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
