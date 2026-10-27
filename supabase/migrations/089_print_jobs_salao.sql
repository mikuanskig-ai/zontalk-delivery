-- ============================================================
-- 089_print_jobs_salao.sql — a fila de impressão passa a aceitar
-- tickets que não são um pedido de delivery (módulo Salão).
--
--   kind     o que imprimir: 'delivery_order' (como sempre), 'salao_round'
--            (itens novos de uma mesa), 'salao_item_cancel', 'salao_bill'
--            (pré-conta) e 'cash_report' (fechamento do caixa).
--   target   em qual impressora: 'cozinha' ou 'caixa'.
--   payload  o conteúdo do ticket, congelado na hora em que o job é
--            criado (um ticket de salão não tem um pedido por trás para
--            ser relido depois).
--
-- order_id passa a aceitar NULL, mas todo job de delivery continua
-- obrigado a ter pedido (print_jobs_order_required).
--
-- claim_print_jobs ganha filtros de kind/target. Os DEFAULTS são
-- deliberadamente os de um agente antigo (só delivery, só cozinha): uma
-- chamada sem os filtros nunca entrega ticket de salão a quem não sabe
-- imprimi-lo.
--
-- print_configs.last_polled_caixa_at: última vez que um agente que
-- declarou ter impressora de caixa consultou a fila — para o painel
-- avisar quando a conta e o fechamento estão parados sem impressora.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

ALTER TABLE print_jobs ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'delivery_order',
  ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'cozinha',
  ADD COLUMN IF NOT EXISTS payload JSONB;

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('delivery_order', 'salao_round', 'salao_item_cancel', 'salao_bill', 'cash_report'));

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_target_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_target_check
  CHECK (target IN ('cozinha', 'caixa'));

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_order_required;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_order_required
  CHECK (kind <> 'delivery_order' OR order_id IS NOT NULL);

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_payload_required;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_payload_required
  CHECK (kind = 'delivery_order' OR payload IS NOT NULL);

ALTER TABLE print_configs
  ADD COLUMN IF NOT EXISTS last_polled_caixa_at TIMESTAMPTZ;

-- A assinatura muda, então a antiga sai antes (senão as duas ficariam
-- coexistindo e uma chamada só com os 2 primeiros argumentos ficaria
-- ambígua).
DROP FUNCTION IF EXISTS public.claim_print_jobs(uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.claim_print_jobs(
  p_account_id uuid,
  p_limit integer,
  p_stale_after_seconds integer DEFAULT 120,
  p_kinds text[] DEFAULT ARRAY['delivery_order'],
  p_targets text[] DEFAULT ARRAY['cozinha']
)
RETURNS SETOF print_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH eligible AS (
    SELECT id
    FROM print_jobs
    WHERE account_id = p_account_id
      AND kind = ANY (p_kinds)
      AND target = ANY (p_targets)
      AND (
        status = 'pending'
        OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => p_stale_after_seconds))
      )
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE print_jobs
  SET status = 'claimed', claimed_at = now()
  WHERE id IN (SELECT id FROM eligible)
  RETURNING *;
$function$;

-- Mesma restrição das migrations 007/012: só o servidor chama.
REVOKE ALL ON FUNCTION public.claim_print_jobs(uuid, integer, integer, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_print_jobs(uuid, integer, integer, text[], text[]) FROM anon;
REVOKE ALL ON FUNCTION public.claim_print_jobs(uuid, integer, integer, text[], text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_print_jobs(uuid, integer, integer, text[], text[]) TO service_role;
