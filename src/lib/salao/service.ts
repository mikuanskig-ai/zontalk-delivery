// ============================================================
// Regras do Salão que falam com o banco. As rotas /api/salao/* são
// finas: autenticam (requireSalao), checam a permissão e chamam daqui.
//
// Tudo filtra por ctx.accountId. O que muda mais de uma linha usa as
// funções SQL atômicas da migration 088.
// ============================================================

import { loadPublicMenu, type PublicMenuProduct } from '@/lib/delivery/public-menu';
import { enqueueSalaoPrint } from '@/lib/delivery/print-queue';
import { buildRoundLines, describeCartError, parseRequestedLines } from './cart';
import { SalaoError, sqlErrorToSalaoError, type SalaoContext } from './context';
import {
  buildBillTicket,
  buildItemCancelTicket,
  buildRoundTicket,
  summarizeDelivery,
  summarizePayments,
  type CashReportTicket,
} from './tickets';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface TabRow {
  id: string;
  table_id: string | null;
  label: string;
  status: 'open' | 'bill_requested' | 'closed' | 'cancelled';
  guests: number;
  customer_name: string | null;
  opened_by_name: string;
  opened_at: string;
  bill_requested_at: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  cash_session_id: string | null;
  service_fee_enabled: boolean;
  service_fee_percent: number;
  discount_amount: number;
  subtotal: number;
  service_fee_amount: number;
  total: number;
  updated_at: string;
}

const TAB_COLUMNS =
  'id, table_id, label, status, guests, customer_name, opened_by_name, opened_at, bill_requested_at, closed_by_name, closed_at, cash_session_id, service_fee_enabled, service_fee_percent, discount_amount, subtotal, service_fee_amount, total, updated_at';

function numeric<T>(row: T, keys: string[]): T {
  const out: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
  for (const k of keys) if (out[k] != null) out[k] = Number(out[k]);
  return out as unknown as T;
}

const TAB_NUMERIC = ['service_fee_percent', 'discount_amount', 'subtotal', 'service_fee_amount', 'total'];

// ------------------------------------------------------------
// Cardápio (cache curto — o celular abre a tela de itens toda hora)
// ------------------------------------------------------------

const MENU_TTL_MS = 30_000;
const menuCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof loadPublicMenu>> }>();

export async function loadMenu(ctx: SalaoContext) {
  const hit = menuCache.get(ctx.accountId);
  if (hit && Date.now() - hit.at < MENU_TTL_MS) return hit.value;
  const value = await loadPublicMenu(ctx.db, ctx.accountId);
  menuCache.set(ctx.accountId, { at: Date.now(), value });
  return value;
}

/** O cardápio do garçom precisa ser o de agora na hora de lançar. */
async function loadFreshProducts(ctx: SalaoContext): Promise<PublicMenuProduct[]> {
  const { categories, uncategorizedProducts } = await loadPublicMenu(ctx.db, ctx.accountId);
  return [...categories.flatMap((c) => c.products), ...uncategorizedProducts];
}

// ------------------------------------------------------------
// Mapa do salão
// ------------------------------------------------------------

export interface FloorTable {
  id: string;
  number: number;
  name: string | null;
  area: string | null;
  status: 'free' | 'open' | 'bill_requested';
  tab: Pick<TabRow, 'id' | 'total' | 'guests' | 'opened_at' | 'opened_by_name' | 'status' | 'bill_requested_at'> | null;
}

export interface CashSessionRow {
  id: string;
  status: 'open' | 'closed';
  opening_float: number;
  opened_by_name: string;
  opened_at: string;
  closed_by_name: string | null;
  closed_at: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  notes: string | null;
}

const CASH_COLUMNS =
  'id, status, opening_float, opened_by_name, opened_at, closed_by_name, closed_at, counted_cash, expected_cash, difference, notes';

export async function loadOpenCash(ctx: SalaoContext): Promise<CashSessionRow | null> {
  const { data } = await ctx.db
    .from('cash_sessions')
    .select(CASH_COLUMNS)
    .eq('account_id', ctx.accountId)
    .eq('status', 'open')
    .maybeSingle();
  return data ? numeric(data as CashSessionRow, ['opening_float', 'counted_cash', 'expected_cash', 'difference']) : null;
}

export async function loadFloor(ctx: SalaoContext) {
  const [tablesRes, tabsRes, cash] = await Promise.all([
    ctx.db
      .from('salao_tables')
      .select('id, number, name, area, position')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .order('position')
      .order('number'),
    ctx.db
      .from('salao_tabs')
      .select(TAB_COLUMNS)
      .eq('account_id', ctx.accountId)
      .in('status', ['open', 'bill_requested'])
      .order('opened_at'),
    loadOpenCash(ctx),
  ]);

  const openTabs = ((tabsRes.data ?? []) as TabRow[]).map((t) => numeric(t, TAB_NUMERIC));
  const byTable = new Map(openTabs.filter((t) => t.table_id).map((t) => [t.table_id as string, t]));

  const tables: FloorTable[] = (tablesRes.data ?? []).map((t) => {
    const tab = byTable.get(t.id) ?? null;
    return {
      id: t.id,
      number: t.number,
      name: t.name,
      area: t.area,
      status: !tab ? 'free' : tab.status === 'bill_requested' ? 'bill_requested' : 'open',
      tab: tab
        ? {
            id: tab.id,
            total: tab.total,
            guests: tab.guests,
            opened_at: tab.opened_at,
            opened_by_name: tab.opened_by_name,
            status: tab.status,
            bill_requested_at: tab.bill_requested_at,
          }
        : null,
    };
  });

  const counterTabs = openTabs
    .filter((t) => !t.table_id)
    .map((t) => ({ id: t.id, label: t.label, total: t.total, opened_at: t.opened_at, opened_by_name: t.opened_by_name, status: t.status }));

  return {
    tables,
    counter_tabs: counterTabs,
    cash,
    totals: {
      open_tabs: openTabs.length,
      open_total: round2(openTabs.reduce((sum, t) => sum + t.total, 0)),
    },
    server_time: new Date().toISOString(),
  };
}

// ------------------------------------------------------------
// Comanda
// ------------------------------------------------------------

async function loadTab(ctx: SalaoContext, tabId: string): Promise<TabRow> {
  const { data } = await ctx.db
    .from('salao_tabs')
    .select(TAB_COLUMNS)
    .eq('id', tabId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!data) throw new SalaoError(404, 'tab_not_found', 'Comanda não encontrada.');
  return numeric(data as TabRow, TAB_NUMERIC);
}

export async function loadTabDetail(ctx: SalaoContext, tabId: string) {
  const tab = await loadTab(ctx, tabId);
  const [roundsRes, itemsRes, paymentsRes] = await Promise.all([
    ctx.db
      .from('salao_rounds')
      .select('id, number, sent_by_name, created_at')
      .eq('tab_id', tabId)
      .eq('account_id', ctx.accountId)
      .order('created_at'),
    ctx.db
      .from('salao_tab_items')
      .select(
        'id, round_id, product_id, product_name, unit_price, quantity, addons_snapshot, line_total, notes, status, cancelled_reason, cancelled_by_name, cancelled_at, created_at',
      )
      .eq('tab_id', tabId)
      .eq('account_id', ctx.accountId)
      .order('created_at'),
    ctx.db
      .from('salao_payments')
      .select('id, method, amount, tendered, change_amount, received_by_name, created_at')
      .eq('tab_id', tabId)
      .eq('account_id', ctx.accountId)
      .order('created_at'),
  ]);
  return {
    tab,
    rounds: roundsRes.data ?? [],
    items: (itemsRes.data ?? []).map((i) => numeric(i, ['unit_price', 'line_total'])),
    payments: (paymentsRes.data ?? []).map((p) => numeric(p, ['amount', 'tendered', 'change_amount'])),
  };
}

export async function openTab(
  ctx: SalaoContext,
  input: { tableId: string | null; guests: number; customerName: string | null },
): Promise<{ tab: TabRow; existing: boolean }> {
  const now = new Date().toISOString();
  const guests = Math.max(1, Math.min(99, Math.trunc(input.guests) || 1));

  if (input.tableId) {
    const { data: table } = await ctx.db
      .from('salao_tables')
      .select('id, number')
      .eq('id', input.tableId)
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .maybeSingle();
    if (!table) throw new SalaoError(404, 'table_not_found', 'Mesa não encontrada.');

    const findOpen = async () => {
      const { data } = await ctx.db
        .from('salao_tabs')
        .select(TAB_COLUMNS)
        .eq('account_id', ctx.accountId)
        .eq('table_id', table.id)
        .in('status', ['open', 'bill_requested'])
        .maybeSingle();
      return data ? numeric(data as TabRow, TAB_NUMERIC) : null;
    };

    const already = await findOpen();
    if (already) return { tab: already, existing: true };

    const { data: created, error } = await ctx.db
      .from('salao_tabs')
      .insert({
        account_id: ctx.accountId,
        table_id: table.id,
        label: `Mesa ${table.number}`,
        guests,
        customer_name: input.customerName,
        opened_by_staff_id: ctx.actor.staffId,
        opened_by_name: ctx.actor.name,
        opened_at: now,
        service_fee_enabled: ctx.settings.service_fee_default_on,
        service_fee_percent: ctx.settings.service_fee_percent,
      })
      .select(TAB_COLUMNS)
      .single();

    if (error) {
      // Dois garçons abriram a mesma mesa ao mesmo tempo: o índice único decidiu.
      if (error.code === '23505') {
        const winner = await findOpen();
        if (winner) return { tab: winner, existing: true };
      }
      console.error('[salao] falha ao abrir comanda:', error.message);
      throw new SalaoError(500, 'internal', 'Não foi possível abrir a comanda. Tente de novo.');
    }
    return { tab: numeric(created as TabRow, TAB_NUMERIC), existing: false };
  }

  // Venda de balcão: comanda sem mesa, sem taxa de serviço, numerada no dia.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { count } = await ctx.db
    .from('salao_tabs')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
    .is('table_id', null)
    .gte('opened_at', startOfDay.toISOString());

  const { data: created, error } = await ctx.db
    .from('salao_tabs')
    .insert({
      account_id: ctx.accountId,
      table_id: null,
      label: `Balcão ${(count ?? 0) + 1}`,
      guests,
      customer_name: input.customerName,
      opened_by_staff_id: ctx.actor.staffId,
      opened_by_name: ctx.actor.name,
      opened_at: now,
      service_fee_enabled: false,
      service_fee_percent: ctx.settings.service_fee_percent,
    })
    .select(TAB_COLUMNS)
    .single();
  if (error) {
    console.error('[salao] falha ao abrir venda de balcão:', error.message);
    throw new SalaoError(500, 'internal', 'Não foi possível abrir a venda. Tente de novo.');
  }
  return { tab: numeric(created as TabRow, TAB_NUMERIC), existing: false };
}

export async function addRound(ctx: SalaoContext, tabId: string, rawItems: unknown) {
  const requested = parseRequestedLines(rawItems);
  if (!requested) throw new SalaoError(400, 'invalid_items', 'Escolha pelo menos um item.');

  const tab = await loadTab(ctx, tabId);
  if (tab.status !== 'open' && tab.status !== 'bill_requested') {
    throw new SalaoError(409, 'tab_not_open', 'Esta comanda já foi fechada. Atualize a tela.');
  }

  const products = await loadFreshProducts(ctx);
  const built = buildRoundLines(products, requested);
  if (!built.ok) throw new SalaoError(400, built.error.code, describeCartError(built.error));

  const { data, error } = await ctx.db.rpc('salao_add_round', {
    p_account_id: ctx.accountId,
    p_tab_id: tabId,
    p_staff_id: ctx.actor.staffId,
    p_staff_name: ctx.actor.name,
    p_items: built.lines,
  });
  if (error) throw sqlErrorToSalaoError(error.message);

  const result = data as { round_id: string; round_number: number };
  const print = await enqueueSalaoPrint(
    ctx.accountId,
    'salao_round',
    'cozinha',
    buildRoundTicket({
      tableLabel: tab.label,
      roundNumber: result.round_number,
      staffName: ctx.actor.name,
      guests: tab.guests,
      createdAt: new Date().toISOString(),
      items: built.lines,
    }),
  );

  return { round_id: result.round_id, round_number: result.round_number, printed: print.queued };
}

export async function cancelItem(ctx: SalaoContext, tabId: string, itemId: string, reason: string | null) {
  const tab = await loadTab(ctx, tabId);
  const { data: item } = await ctx.db
    .from('salao_tab_items')
    .select('id, tab_id, product_name, quantity, unit_price, line_total, addons_snapshot, notes, status')
    .eq('id', itemId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!item || item.tab_id !== tabId) throw new SalaoError(404, 'item_not_found', 'Item não encontrado.');

  const cleanReason = reason?.trim().slice(0, 200) || null;
  const { error } = await ctx.db.rpc('salao_cancel_item', {
    p_account_id: ctx.accountId,
    p_item_id: itemId,
    p_staff_id: ctx.actor.staffId,
    p_staff_name: ctx.actor.name,
    p_reason: cleanReason,
  });
  if (error) throw sqlErrorToSalaoError(error.message);

  const print = await enqueueSalaoPrint(
    ctx.accountId,
    'salao_item_cancel',
    'cozinha',
    buildItemCancelTicket({
      tableLabel: tab.label,
      staffName: ctx.actor.name,
      reason: cleanReason,
      createdAt: new Date().toISOString(),
      item,
    }),
  );
  return { printed: print.queued };
}

export async function updateTab(
  ctx: SalaoContext,
  tabId: string,
  patch: { guests?: number; customer_name?: string | null; service_fee_enabled?: boolean; discount_amount?: number },
) {
  const tab = await loadTab(ctx, tabId);
  if (tab.status !== 'open' && tab.status !== 'bill_requested') {
    throw new SalaoError(409, 'tab_not_open', 'Esta comanda já foi fechada. Atualize a tela.');
  }
  const update: Record<string, unknown> = {};
  if (patch.guests != null) update.guests = Math.max(1, Math.min(99, Math.trunc(patch.guests) || 1));
  if (patch.customer_name !== undefined) update.customer_name = patch.customer_name?.trim().slice(0, 80) || null;
  if (patch.service_fee_enabled != null) update.service_fee_enabled = patch.service_fee_enabled;
  if (patch.discount_amount != null) {
    const discount = round2(Number(patch.discount_amount));
    if (!Number.isFinite(discount) || discount < 0) {
      throw new SalaoError(400, 'invalid_discount', 'Desconto inválido.');
    }
    if (discount > tab.subtotal + tab.service_fee_amount) {
      throw new SalaoError(400, 'invalid_discount', 'O desconto não pode ser maior que a conta.');
    }
    update.discount_amount = discount;
  }
  if (Object.keys(update).length > 0) {
    const { error } = await ctx.db.from('salao_tabs').update(update).eq('id', tabId).eq('account_id', ctx.accountId);
    if (error) throw new SalaoError(500, 'internal', 'Não foi possível salvar. Tente de novo.');
    await ctx.db.rpc('salao_recalc_tab', { p_tab: tabId });
  }
  return loadTab(ctx, tabId);
}

export async function requestBill(ctx: SalaoContext, tabId: string) {
  const tab = await loadTab(ctx, tabId);
  if (tab.status !== 'open' && tab.status !== 'bill_requested') {
    throw new SalaoError(409, 'tab_not_open', 'Esta comanda já foi fechada. Atualize a tela.');
  }
  if (tab.status === 'open') {
    await ctx.db
      .from('salao_tabs')
      .update({ status: 'bill_requested', bill_requested_at: new Date().toISOString() })
      .eq('id', tabId)
      .eq('account_id', ctx.accountId)
      .eq('status', 'open');
  }
  await ctx.db.rpc('salao_recalc_tab', { p_tab: tabId });

  const detail = await loadTabDetail(ctx, tabId);
  const active = detail.items.filter((i) => i.status === 'active');
  const print = await enqueueSalaoPrint(
    ctx.accountId,
    'salao_bill',
    'caixa',
    buildBillTicket({
      tableLabel: detail.tab.label,
      guests: detail.tab.guests,
      openedAt: detail.tab.opened_at,
      createdAt: new Date().toISOString(),
      currency: ctx.account.currency,
      items: active,
      subtotal: detail.tab.subtotal,
      serviceFeeEnabled: detail.tab.service_fee_enabled,
      serviceFeePercent: detail.tab.service_fee_percent,
      serviceFeeAmount: detail.tab.service_fee_amount,
      discountAmount: detail.tab.discount_amount,
      total: detail.tab.total,
    }),
  );
  return { tab: detail.tab, printed: print.queued };
}

export async function transferTab(ctx: SalaoContext, tabId: string, toTableId: string) {
  const { data, error } = await ctx.db.rpc('salao_transfer_tab', {
    p_account_id: ctx.accountId,
    p_tab_id: tabId,
    p_to_table_id: toTableId,
  });
  if (error) throw sqlErrorToSalaoError(error.message);
  return data as { tab_id: string; merged: boolean };
}

// ------------------------------------------------------------
// Fechamento da comanda
// ------------------------------------------------------------

export interface PaymentInput {
  method: 'pix' | 'credit' | 'debit' | 'cash' | 'other';
  amount: number;
  tendered?: number | null;
}

const METHODS = ['pix', 'credit', 'debit', 'cash', 'other'] as const;

export function parsePayments(raw: unknown): PaymentInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PaymentInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.method !== 'string' || !(METHODS as readonly string[]).includes(e.method)) return null;
    const amount = round2(Number(e.amount));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const payment: PaymentInput = { method: e.method as PaymentInput['method'], amount };
    if (e.method === 'cash' && e.tendered != null && e.tendered !== '') {
      const tendered = round2(Number(e.tendered));
      if (!Number.isFinite(tendered) || tendered < amount) return null;
      payment.tendered = tendered;
    }
    out.push(payment);
  }
  return out;
}

export async function closeTab(ctx: SalaoContext, tabId: string, rawPayments: unknown) {
  const payments = parsePayments(rawPayments);
  if (!payments) {
    throw new SalaoError(400, 'invalid_payments', 'Pagamento inválido. Confira a forma e o valor.');
  }

  const cash = await loadOpenCash(ctx);
  if (!cash && ctx.settings.require_open_cash) {
    throw new SalaoError(409, 'cash_closed', 'Abra o caixa antes de receber pagamentos.');
  }

  const { data, error } = await ctx.db.rpc('salao_close_tab', {
    p_account_id: ctx.accountId,
    p_tab_id: tabId,
    p_staff_id: ctx.actor.staffId,
    p_staff_name: ctx.actor.name,
    p_payments: payments,
    p_cash_session_id: cash?.id ?? null,
  });
  if (error) throw sqlErrorToSalaoError(error.message);
  const result = data as { tab_id: string; total: number };

  const change = payments.reduce(
    (sum, p) => sum + (p.method === 'cash' && p.tendered != null ? p.tendered - p.amount : 0),
    0,
  );
  return { tab_id: result.tab_id, total: Number(result.total), change: round2(change) };
}

export async function reopenTab(ctx: SalaoContext, tabId: string) {
  const { error } = await ctx.db.rpc('salao_reopen_tab', { p_account_id: ctx.accountId, p_tab_id: tabId });
  if (error) throw sqlErrorToSalaoError(error.message);
}

// ------------------------------------------------------------
// Caixa do dia
// ------------------------------------------------------------

export async function openCash(ctx: SalaoContext, openingFloat: number) {
  const value = round2(Number(openingFloat));
  if (!Number.isFinite(value) || value < 0) {
    throw new SalaoError(400, 'invalid_float', 'Informe o fundo de troco (pode ser zero).');
  }
  const { data, error } = await ctx.db
    .from('cash_sessions')
    .insert({
      account_id: ctx.accountId,
      opening_float: value,
      opened_by_staff_id: ctx.actor.staffId,
      opened_by_name: ctx.actor.name,
    })
    .select(CASH_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') throw new SalaoError(409, 'cash_already_open', 'O caixa já está aberto.');
    console.error('[salao] falha ao abrir caixa:', error.message);
    throw new SalaoError(500, 'internal', 'Não foi possível abrir o caixa.');
  }
  return numeric(data as CashSessionRow, ['opening_float', 'counted_cash', 'expected_cash', 'difference']);
}

export async function addCashMovement(
  ctx: SalaoContext,
  input: { kind: unknown; amount: unknown; reason: unknown },
) {
  if (input.kind !== 'withdrawal' && input.kind !== 'supply') {
    throw new SalaoError(400, 'invalid_movement', 'Escolha sangria ou suprimento.');
  }
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new SalaoError(400, 'invalid_movement', 'Informe um valor maior que zero.');
  }
  const cash = await loadOpenCash(ctx);
  if (!cash) throw new SalaoError(409, 'cash_closed', 'O caixa está fechado.');

  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : null;
  const { error } = await ctx.db.from('cash_movements').insert({
    account_id: ctx.accountId,
    cash_session_id: cash.id,
    kind: input.kind,
    amount,
    reason,
    by_staff_id: ctx.actor.staffId,
    by_name: ctx.actor.name,
  });
  if (error) throw new SalaoError(500, 'internal', 'Não foi possível registrar.');
}

/** Monta o relatório do caixa (aberto = parcial; fechado = o do fechamento). */
export async function buildCashReport(ctx: SalaoContext, sessionId: string): Promise<CashReportTicket> {
  const { data: session } = await ctx.db
    .from('cash_sessions')
    .select(CASH_COLUMNS)
    .eq('id', sessionId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!session) throw new SalaoError(404, 'session_not_found', 'Caixa não encontrado.');
  const s = numeric(session as CashSessionRow, ['opening_float', 'counted_cash', 'expected_cash', 'difference']);

  const until = s.closed_at ?? new Date().toISOString();
  const [paymentsRes, movementsRes, tabsRes, deliveryRes] = await Promise.all([
    ctx.db
      .from('salao_payments')
      .select('method, amount')
      .eq('account_id', ctx.accountId)
      .eq('cash_session_id', sessionId),
    ctx.db
      .from('cash_movements')
      .select('kind, amount, reason, by_name, created_at')
      .eq('account_id', ctx.accountId)
      .eq('cash_session_id', sessionId)
      .order('created_at'),
    ctx.db
      .from('salao_tabs')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('cash_session_id', sessionId)
      .eq('status', 'closed'),
    ctx.db
      .from('delivery_orders')
      .select('total, payment_method, status')
      .eq('account_id', ctx.accountId)
      .gte('created_at', s.opened_at)
      .lte('created_at', until)
      .not('status', 'in', '(cancelled,draft)'),
  ]);

  const payments = (paymentsRes.data ?? []).map((p) => ({ method: p.method as string, amount: Number(p.amount) }));
  const movements = (movementsRes.data ?? []).map((m) => ({
    kind: m.kind as 'withdrawal' | 'supply',
    amount: Number(m.amount),
    reason: m.reason as string | null,
    by_name: m.by_name as string,
    created_at: m.created_at as string,
  }));
  const byMethod = summarizePayments(payments);
  const delivery = summarizeDelivery(
    (deliveryRes.data ?? []).map((o) => ({ total: Number(o.total), payment_method: o.payment_method as string | null })),
  );

  return {
    type: 'cash_report',
    currency: ctx.account.currency,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    opened_by: s.opened_by_name,
    closed_by: s.closed_by_name,
    opening_float: s.opening_float,
    counted_cash: s.counted_cash,
    expected_cash: s.expected_cash,
    difference: s.difference,
    notes: s.notes,
    salao_tabs_count: tabsRes.count ?? 0,
    salao_total: round2(Object.values(byMethod).reduce((a, b) => a + b, 0)),
    salao_by_method: byMethod,
    supply_total: round2(movements.filter((m) => m.kind === 'supply').reduce((a, m) => a + m.amount, 0)),
    withdrawal_total: round2(movements.filter((m) => m.kind === 'withdrawal').reduce((a, m) => a + m.amount, 0)),
    delivery_orders_count: delivery.count,
    delivery_total: delivery.total,
    delivery_by_method: delivery.byMethod,
    movements,
  };
}

export async function closeCash(ctx: SalaoContext, counted: unknown, notes: unknown) {
  const cash = await loadOpenCash(ctx);
  if (!cash) throw new SalaoError(409, 'cash_closed', 'O caixa já está fechado.');
  const value = round2(Number(counted));
  if (!Number.isFinite(value) || value < 0) {
    throw new SalaoError(400, 'invalid_counted', 'Informe o valor contado no caixa.');
  }
  const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 500) : null;

  const { data, error } = await ctx.db.rpc('salao_close_cash_session', {
    p_account_id: ctx.accountId,
    p_session_id: cash.id,
    p_staff_id: ctx.actor.staffId,
    p_staff_name: ctx.actor.name,
    p_counted: value,
    p_notes: cleanNotes,
  });
  if (error) throw sqlErrorToSalaoError(error.message);

  const report = await buildCashReport(ctx, cash.id);
  const print = await enqueueSalaoPrint(ctx.accountId, 'cash_report', 'caixa', report);

  const { count: stillOpen } = await ctx.db
    .from('salao_tabs')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
    .in('status', ['open', 'bill_requested']);

  return {
    ...(data as { expected_cash: number; counted_cash: number; difference: number }),
    session_id: cash.id,
    printed: print.queued,
    open_tabs_left: stillOpen ?? 0,
  };
}
