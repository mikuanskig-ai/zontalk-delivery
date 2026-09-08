-- ============================================================
-- 078_print_compact_mode.sql — opção de impressão compacta
-- (letra em tamanho normal, não em altura dupla) por conta.
--
-- Pedido do Eder (2026-09-07): o redesenho da notinha (0.24.0) tem mais
-- seções que o formato antigo (tabela de itens, PAGAMENTO/TROCO,
-- OBSERVAÇÃO GERAL, checklist) — com DOUBLE_SIZE ligado no ticket
-- inteiro (receipt.ts), isso deixou a notinha física bem mais comprida
-- do que antes. `compact_print` deixa a conta desligar a altura dupla
-- e imprimir em tamanho normal, mais curto.
--
-- Default false — mantém o comportamento atual (altura dupla) pra
-- quem já está acostumado, muda só quem ligar explicitamente.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE print_configs
  ADD COLUMN IF NOT EXISTS compact_print boolean NOT NULL DEFAULT false;
