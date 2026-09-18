-- ============================================================
-- 081_meta_capi.sql — Meta Conversions API (CAPI) for CTWA ad
-- attribution, "partner" model (no per-tenant token/Pixel-ID typing)
--
-- Pedido do Eder: mesma ideia já construída no zontalk-crm (fechar o
-- funil de anúncio "Clique para WhatsApp" avisando a Meta quando um
-- lead vira venda), mas sem pedir Pixel ID / token de acesso pro
-- tenant — em vez disso, o app do Zontalk vira "parceiro" no Business
-- Manager de cada cliente (o cliente só faz UM clique: Configurações
-- do Negócio → Parceiros → Adicionar → cola o BM ID do Zontalk → dá
-- acesso ao Pixel + à conta do WhatsApp Business), e a plataforma usa
-- UM ÚNICO token de Usuário de Sistema (do PRÓPRIO Business Manager do
-- Zontalk, não por conta) pra descobrir e usar esses ativos.
--
-- Isso significa: NENHUM segredo por conta nesta tabela — o token vive
-- só em variável de ambiente do servidor (`META_CAPI_SYSTEM_USER_TOKEN`,
-- `META_CAPI_BUSINESS_ID`), igual a `SUPABASE_SERVICE_ROLE_KEY`. O que
-- fica por conta aqui é só QUAL pixel/WABA (dentre os que foram
-- compartilhados com o Business Manager do Zontalk) pertence a essa
-- conta — escolhido pelo admin numa lista (auto-descoberta via Graph
-- API), nunca digitado.
--
-- Gatilho do evento "Purchase": pedido de delivery criado de verdade
-- (finalizeDeliveryOrder, exclui os de teste do simulador de impressão
-- — skipSideEffects) — ver src/lib/delivery/create-order.ts.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- Atribuição de clique em anúncio CTWA (Clique-para-WhatsApp) — mesmo
-- lugar/convenção do zontalk-crm: grava só na primeira mensagem
-- recebida do contato (nunca sobrescreve depois), best-effort — nem
-- todo contato vem de um anúncio, e a extração em si (contextInfo.
-- externalAdReply.ctwaClid do protocolo whatsmeow) ainda não foi
-- confirmada contra um clique real chegando pelo webhook do WuzAPI
-- nesta base (mesma cautela documentada no zontalk-crm).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_attribution jsonb;

CREATE TABLE IF NOT EXISTS meta_capi_configs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                        uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  pixel_id                          text,
  pixel_name                        text,
  whatsapp_business_account_id     text,
  whatsapp_business_account_name   text,
  is_active                         boolean NOT NULL DEFAULT false,
  -- Meta's "Test Events" tool code (Events Manager > Test events) —
  -- optional, lets an admin verify a real send without polluting real
  -- ad-optimization data. Not a secret.
  test_event_code                  text,
  linked_at                         timestamptz,
  linked_by                         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_capi_configs_account_id ON meta_capi_configs(account_id);

ALTER TABLE meta_capi_configs ENABLE ROW LEVEL SECURITY;

-- Settings-class RLS, mirrors ai_configs/whatsapp_config: any member
-- may read (so the UI can show "conectado"), only admin+ may change.
DROP POLICY IF EXISTS meta_capi_configs_select ON meta_capi_configs;
CREATE POLICY meta_capi_configs_select ON meta_capi_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_capi_configs_insert ON meta_capi_configs;
CREATE POLICY meta_capi_configs_insert ON meta_capi_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_capi_configs_update ON meta_capi_configs;
CREATE POLICY meta_capi_configs_update ON meta_capi_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_capi_configs_delete ON meta_capi_configs;
CREATE POLICY meta_capi_configs_delete ON meta_capi_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_meta_capi_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meta_capi_configs_updated_at ON meta_capi_configs;
CREATE TRIGGER meta_capi_configs_updated_at
  BEFORE UPDATE ON meta_capi_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_meta_capi_configs_updated_at();
