-- ============================================================
-- 083_backfill_contact_order_stats.sql — one-time data backfill.
--
-- From v0.33.0 the order flow keeps four purchase fields on every
-- contact that orders (custom fields "Total gasto", "Pedidos",
-- "Último pedido", "Ticket médio" — see
-- src/lib/delivery/contact-order-stats.ts). This fills them in for
-- everyone who already ordered, so the contacts CSV export is a
-- usable Meta Ads audience / LTV list from day one instead of only for
-- future orders.
--
-- Same rules as the app: cancelled orders don't count, the date is in
-- America/Sao_Paulo, values are recomputed (not incremented) so this is
-- idempotent — safe to run any number of times.
-- ============================================================

INSERT INTO custom_fields (account_id, user_id, field_name, field_type)
SELECT a.id, a.owner_user_id, n.name, 'text'
FROM accounts a
CROSS JOIN (VALUES ('Total gasto'), ('Pedidos'), ('Último pedido'), ('Ticket médio')) AS n(name)
WHERE a.owner_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM delivery_orders o
    WHERE o.account_id = a.id AND o.contact_id IS NOT NULL AND o.status <> 'cancelled'
  )
  AND NOT EXISTS (
    SELECT 1 FROM custom_fields f WHERE f.account_id = a.id AND f.field_name = n.name
  );

WITH agg AS (
  SELECT
    o.account_id,
    o.contact_id,
    count(*) AS cnt,
    round(sum(o.total)::numeric, 2) AS tot,
    round(avg(o.total)::numeric, 2) AS avg_ticket,
    (max(o.created_at) AT TIME ZONE 'America/Sao_Paulo')::date AS last_day
  FROM delivery_orders o
  WHERE o.contact_id IS NOT NULL AND o.status <> 'cancelled'
  GROUP BY o.account_id, o.contact_id
), vals AS (
  SELECT
    agg.contact_id,
    f.id AS field_id,
    CASE f.field_name
      WHEN 'Total gasto'   THEN agg.tot::text
      WHEN 'Pedidos'       THEN agg.cnt::text
      WHEN 'Último pedido' THEN agg.last_day::text
      WHEN 'Ticket médio'  THEN agg.avg_ticket::text
    END AS v
  FROM agg
  JOIN custom_fields f
    ON f.account_id = agg.account_id
   AND f.field_name IN ('Total gasto', 'Pedidos', 'Último pedido', 'Ticket médio')
)
INSERT INTO contact_custom_values (contact_id, custom_field_id, value)
SELECT contact_id, field_id, v FROM vals
ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value;
