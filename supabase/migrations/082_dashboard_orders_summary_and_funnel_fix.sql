-- ============================================================
-- 082_dashboard_orders_summary_and_funnel_fix.sql
--
-- 1. delivery_orders_summary — novo RPC do dashboard: quantidade e
--    valor dos pedidos do período (batem 1:1 com a lista de Pedidos,
--    que também exclui cancelados) + "faturado" = pedidos que já
--    tiveram ao menos 1 impressão concluída (print_jobs.status =
--    'printed'). EXISTS (não JOIN) porque um pedido pode ter várias
--    impressões (reimpressão) e o valor não pode ser somado em dobro.
--
-- 2. delivery_customer_funnel — corrige a definição do estágio 2.
--    Antes (076): "converteram" = só contatos CRIADOS no período que
--    também pediram no período. Isso fazia o funil discordar da aba
--    de Pedidos: pedido de cliente antigo (contato criado antes do
--    período) não entrava em lugar nenhum. Agora "converteram" =
--    clientes distintos com >=1 pedido não cancelado NO período,
--    independente de quando o contato foi criado. Recorrentes/fiéis
--    continuam sendo contagem vitalícia (2+/3+ pedidos) dentro desse
--    grupo. Consequência assumida: o estágio 2 deixa de ser
--    subconjunto do estágio 1 (por isso a UI não mostra mais "% dos
--    novos contatos" — poderia passar de 100%).
--
-- SECURITY INVOKER (padrão) — RLS de delivery_orders/print_jobs/
-- contacts escopa a leitura à conta do chamador, igual 076.
--
-- Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delivery_orders_summary(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  orders_count BIGINT,
  orders_total NUMERIC,
  printed_count BIGINT,
  printed_total NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*)::BIGINT,
    COALESCE(sum(o.total), 0)::NUMERIC,
    (count(*) FILTER (WHERE has_print.printed))::BIGINT,
    COALESCE(sum(o.total) FILTER (WHERE has_print.printed), 0)::NUMERIC
  FROM delivery_orders o
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM print_jobs pj
      WHERE pj.order_id = o.id AND pj.status = 'printed'
    ) AS printed
  ) has_print
  WHERE o.account_id = p_account_id
    AND o.created_at >= p_from
    AND o.created_at <= p_to
    AND o.status <> 'cancelled';
$$;

ALTER FUNCTION public.delivery_orders_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delivery_orders_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_orders_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.delivery_customer_funnel(
  p_account_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  new_contacts BIGINT,
  ordering_customers BIGINT,
  returning_customers BIGINT,
  loyal_customers BIGINT,
  unattributed_orders BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH new_contacts_cte AS (
    SELECT c.id
    FROM contacts c
    WHERE c.account_id = p_account_id
      AND c.created_at >= p_from
      AND c.created_at <= p_to
  ),
  ordering_cte AS (
    SELECT DISTINCT o.contact_id AS id
    FROM delivery_orders o
    WHERE o.account_id = p_account_id
      AND o.created_at >= p_from
      AND o.created_at <= p_to
      AND o.status <> 'cancelled'
      AND o.contact_id IS NOT NULL
  ),
  lifetime_cte AS (
    SELECT o.contact_id AS id, count(*) AS lifetime_orders
    FROM delivery_orders o
    WHERE o.account_id = p_account_id
      AND o.status <> 'cancelled'
      AND o.contact_id IN (SELECT id FROM ordering_cte)
    GROUP BY o.contact_id
  )
  SELECT
    (SELECT count(*) FROM new_contacts_cte)::BIGINT,
    (SELECT count(*) FROM ordering_cte)::BIGINT,
    (SELECT count(*) FROM lifetime_cte WHERE lifetime_orders >= 2)::BIGINT,
    (SELECT count(*) FROM lifetime_cte WHERE lifetime_orders >= 3)::BIGINT,
    (
      SELECT count(*)
      FROM delivery_orders o
      WHERE o.account_id = p_account_id
        AND o.created_at >= p_from
        AND o.created_at <= p_to
        AND o.status <> 'cancelled'
        AND o.contact_id IS NULL
    )::BIGINT;
$$;
