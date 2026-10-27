// ============================================================
// Conteúdo dos tickets do Salão — puro. É o JSON que vai em
// print_jobs.payload e que o Print Agent (>= 1.5.0) transforma em
// papel. Congelado na criação do job: um ticket de salão não tem um
// pedido por trás para ser relido depois.
// ============================================================

export interface TicketItem {
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  addons_snapshot: unknown;
  notes: string | null;
}

export interface SalaoRoundTicket {
  type: 'salao_round';
  table_label: string;
  round_number: number;
  staff_name: string;
  guests: number | null;
  created_at: string;
  items: TicketItem[];
}

export interface SalaoItemCancelTicket {
  type: 'salao_item_cancel';
  table_label: string;
  staff_name: string;
  reason: string | null;
  created_at: string;
  item: TicketItem;
}

export interface SalaoBillTicket {
  type: 'salao_bill';
  table_label: string;
  guests: number;
  opened_at: string;
  created_at: string;
  currency: string;
  items: TicketItem[];
  subtotal: number;
  service_fee_percent: number | null;
  service_fee_amount: number;
  discount_amount: number;
  total: number;
  per_person: number | null;
}

export type PaymentMethodKey = 'pix' | 'credit' | 'debit' | 'cash' | 'other';

export interface CashReportMovement {
  kind: 'withdrawal' | 'supply';
  amount: number;
  reason: string | null;
  by_name: string;
  created_at: string;
}

export interface CashReportTicket {
  type: 'cash_report';
  currency: string;
  opened_at: string;
  closed_at: string | null;
  opened_by: string;
  closed_by: string | null;
  opening_float: number;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  notes: string | null;
  salao_tabs_count: number;
  salao_total: number;
  salao_by_method: Record<PaymentMethodKey, number>;
  supply_total: number;
  withdrawal_total: number;
  delivery_orders_count: number;
  delivery_total: number;
  delivery_by_method: Record<DeliveryMethodKey, { count: number; total: number }>;
  movements: CashReportMovement[];
}

export type SalaoTicket = SalaoRoundTicket | SalaoItemCancelTicket | SalaoBillTicket | CashReportTicket;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function toTicketItem(row: {
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  addons_snapshot?: unknown;
  notes?: string | null;
}): TicketItem {
  return {
    product_name: row.product_name,
    quantity: row.quantity,
    unit_price: Number(row.unit_price),
    line_total: Number(row.line_total),
    addons_snapshot: row.addons_snapshot ?? [],
    notes: row.notes ?? null,
  };
}

export function buildRoundTicket(input: {
  tableLabel: string;
  roundNumber: number;
  staffName: string;
  guests: number | null;
  createdAt: string;
  items: Parameters<typeof toTicketItem>[0][];
}): SalaoRoundTicket {
  return {
    type: 'salao_round',
    table_label: input.tableLabel,
    round_number: input.roundNumber,
    staff_name: input.staffName,
    guests: input.guests,
    created_at: input.createdAt,
    items: input.items.map(toTicketItem),
  };
}

export function buildItemCancelTicket(input: {
  tableLabel: string;
  staffName: string;
  reason: string | null;
  createdAt: string;
  item: Parameters<typeof toTicketItem>[0];
}): SalaoItemCancelTicket {
  return {
    type: 'salao_item_cancel',
    table_label: input.tableLabel,
    staff_name: input.staffName,
    reason: input.reason,
    created_at: input.createdAt,
    item: toTicketItem(input.item),
  };
}

/** Valor por pessoa — null quando só há uma pessoa (não adianta imprimir). */
export function perPerson(total: number, guests: number): number | null {
  if (!Number.isFinite(guests) || guests <= 1) return null;
  return round2(total / guests);
}

export function buildBillTicket(input: {
  tableLabel: string;
  guests: number;
  openedAt: string;
  createdAt: string;
  currency: string;
  items: Parameters<typeof toTicketItem>[0][];
  subtotal: number;
  serviceFeeEnabled: boolean;
  serviceFeePercent: number;
  serviceFeeAmount: number;
  discountAmount: number;
  total: number;
}): SalaoBillTicket {
  return {
    type: 'salao_bill',
    table_label: input.tableLabel,
    guests: input.guests,
    opened_at: input.openedAt,
    created_at: input.createdAt,
    currency: input.currency,
    items: input.items.map(toTicketItem),
    subtotal: Number(input.subtotal),
    service_fee_percent: input.serviceFeeEnabled ? Number(input.serviceFeePercent) : null,
    service_fee_amount: Number(input.serviceFeeAmount),
    discount_amount: Number(input.discountAmount),
    total: Number(input.total),
    per_person: perPerson(Number(input.total), input.guests),
  };
}

// ------------------------------------------------------------
// Delivery no fechamento do caixa
// ------------------------------------------------------------

export type DeliveryMethodKey = 'pix' | 'cash' | 'card' | 'other' | 'unknown';

/**
 * delivery_orders.payment_method é texto livre ("Pix", "dinheiro",
 * "Cartão na entrega", "troco pra 100"...). Agrupa no que dá para ler
 * com segurança; o que não dá para classificar fica em 'other', e a
 * falta de informação em 'unknown' — nunca chuta.
 */
export function normalizeDeliveryMethod(raw: string | null | undefined): DeliveryMethodKey {
  const text = (raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  if (!text) return 'unknown';
  if (/\bpix\b/.test(text)) return 'pix';
  if (/dinheiro|especie|\bcash\b/.test(text)) return 'cash';
  if (/cart|credito|debito|maquin|visa|master|elo\b/.test(text)) return 'card';
  return 'other';
}

export function emptyDeliveryByMethod(): Record<DeliveryMethodKey, { count: number; total: number }> {
  return {
    pix: { count: 0, total: 0 },
    cash: { count: 0, total: 0 },
    card: { count: 0, total: 0 },
    other: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
  };
}

export function summarizeDelivery(orders: { total: number; payment_method: string | null }[]): {
  count: number;
  total: number;
  byMethod: Record<DeliveryMethodKey, { count: number; total: number }>;
} {
  const byMethod = emptyDeliveryByMethod();
  let total = 0;
  for (const order of orders) {
    const key = normalizeDeliveryMethod(order.payment_method);
    byMethod[key].count += 1;
    byMethod[key].total = round2(byMethod[key].total + Number(order.total));
    total = round2(total + Number(order.total));
  }
  return { count: orders.length, total, byMethod };
}

export function emptySalaoByMethod(): Record<PaymentMethodKey, number> {
  return { pix: 0, credit: 0, debit: 0, cash: 0, other: 0 };
}

export function summarizePayments(
  payments: { method: string; amount: number }[],
): Record<PaymentMethodKey, number> {
  const out = emptySalaoByMethod();
  for (const p of payments) {
    const key = (p.method in out ? p.method : 'other') as PaymentMethodKey;
    out[key] = round2(out[key] + Number(p.amount));
  }
  return out;
}
