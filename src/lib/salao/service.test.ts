import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueSalaoPrint: vi.fn(),
  loadPublicMenu: vi.fn(),
}));

vi.mock('@/lib/delivery/print-queue', () => ({ enqueueSalaoPrint: mocks.enqueueSalaoPrint }));
vi.mock('@/lib/delivery/public-menu', () => ({ loadPublicMenu: mocks.loadPublicMenu }));

import type { SalaoContext } from './context';
import { addRound, cancelItem, closeTab, openTab, parsePayments, requestBill, updateTab } from './service';

type Resp = { data?: unknown; error?: { code?: string; message: string } | null; count?: number };

/**
 * Banco de mentira por tabela: cada consulta devolve o que o teste
 * configurou (um único registro, uma lista ou o resultado de um insert) e
 * registra os inserts/rpc para o teste conferir.
 */
function fakeDb(config: {
  one?: Record<string, Resp | (() => Resp)>;
  insert?: Record<string, (payload: unknown) => Resp>;
  rpc?: Record<string, (args: Record<string, unknown>) => Resp>;
  count?: Record<string, number>;
}) {
  const inserts: { table: string; payload: unknown }[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  function chain(table: string) {
    let inserted: Resp | null = null;
    const resolveOne = (): Resp => {
      if (inserted) return inserted;
      const v = config.one?.[table];
      const r = typeof v === 'function' ? v() : v;
      return r ?? { data: null, error: null };
    };
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gte', 'order', 'limit', 'not', 'update']) c[m] = () => c;
    c.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      inserted = config.insert?.[table]?.(payload) ?? { data: payload, error: null };
      return c;
    };
    c.maybeSingle = () => Promise.resolve(resolveOne());
    c.single = () => Promise.resolve(resolveOne());
    c.then = (resolve: (v: unknown) => void) =>
      resolve({ data: [], error: null, count: config.count?.[table] ?? 0 });
    return c;
  }

  return {
    from: (table: string) => chain(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(config.rpc?.[fn]?.(args) ?? { data: {}, error: null });
    },
    inserts,
    rpcCalls,
  };
}

function ctxWith(db: ReturnType<typeof fakeDb>, over: Partial<SalaoContext> = {}): SalaoContext {
  return {
    actor: { accountId: 'acc-1', role: 'garcom', staffId: 'staff-1', name: 'Carlos', deviceId: 'dev-1', via: 'device' },
    accountId: 'acc-1',
    db: db as unknown as SalaoContext['db'],
    settings: { service_fee_percent: 10, service_fee_default_on: true, require_open_cash: true, permissions: {} },
    account: { name: 'Concórdia', currency: 'BRL', slug: 'concordia' },
    ...over,
  };
}

const tabRow = (over: Record<string, unknown> = {}) => ({
  id: 'tab-1', table_id: 'tbl-1', label: 'Mesa 12', status: 'open', guests: 4, customer_name: null,
  opened_by_name: 'Ana', opened_at: '2026-10-27T15:00:00Z', bill_requested_at: null, closed_by_name: null,
  closed_at: null, cash_session_id: null, service_fee_enabled: true, service_fee_percent: 10, discount_amount: 0,
  subtotal: 100, service_fee_amount: 10, total: 110, updated_at: '2026-10-27T15:00:00Z', ...over,
});

const menu = {
  categories: [
    {
      id: 'c1', name: 'Pratos', position: 0,
      products: [
        { id: 'p-marmita', name: 'Marmita P', description: null, price: 28, image_url: null, position: 0, addon_groups: [] },
        {
          id: 'p-carne', name: 'Prato do dia', description: null, price: 40, image_url: null, position: 1,
          addon_groups: [{ id: 'g1', name: 'Ponto', selection_type: 'single', is_required: true, min_select: 1, max_select: 1, options: [{ id: 'o1', name: 'Ao ponto', price_delta: 0 }] }],
        },
      ],
    },
  ],
  uncategorizedProducts: [],
};

beforeEach(() => {
  mocks.enqueueSalaoPrint.mockReset();
  mocks.enqueueSalaoPrint.mockResolvedValue({ queued: true });
  mocks.loadPublicMenu.mockReset();
  mocks.loadPublicMenu.mockResolvedValue(menu);
});

describe('parsePayments', () => {
  it('aceita formas válidas e arredonda para centavos', () => {
    expect(parsePayments([{ method: 'pix', amount: 50.004 }, { method: 'cash', amount: 30, tendered: 50 }])).toEqual([
      { method: 'pix', amount: 50 },
      { method: 'cash', amount: 30, tendered: 50 },
    ]);
  });

  it('recusa valor zero, negativo, método inventado e forma errada', () => {
    expect(parsePayments([{ method: 'pix', amount: 0 }])).toBeNull();
    expect(parsePayments([{ method: 'pix', amount: -5 }])).toBeNull();
    expect(parsePayments([{ method: 'cheque', amount: 10 }])).toBeNull();
    expect(parsePayments([{ method: 'pix', amount: 'abc' }])).toBeNull();
    expect(parsePayments('x')).toBeNull();
    expect(parsePayments([null])).toBeNull();
  });

  it('dinheiro entregue menor que o valor é recusado', () => {
    expect(parsePayments([{ method: 'cash', amount: 30, tendered: 20 }])).toBeNull();
  });

  it('lista vazia é válida (comanda de R$ 0)', () => {
    expect(parsePayments([])).toEqual([]);
  });

  it('"tendered" só vale para dinheiro', () => {
    expect(parsePayments([{ method: 'pix', amount: 30, tendered: 50 }])).toEqual([{ method: 'pix', amount: 30 }]);
  });
});

describe('addRound', () => {
  it('lança a rodada e manda para a cozinha só os itens novos, com a mesa', async () => {
    const db = fakeDb({
      one: { salao_tabs: { data: tabRow() } },
      rpc: { salao_add_round: () => ({ data: { round_id: 'r1', round_number: 2 }, error: null }) },
    });
    const result = await addRound(ctxWith(db), 'tab-1', [{ product_id: 'p-marmita', quantity: 2 }]);

    expect(result).toEqual({ round_id: 'r1', round_number: 2, printed: true });
    const call = db.rpcCalls[0];
    expect(call.fn).toBe('salao_add_round');
    expect(call.args).toMatchObject({ p_account_id: 'acc-1', p_tab_id: 'tab-1', p_staff_id: 'staff-1', p_staff_name: 'Carlos' });
    // preço calculado no servidor
    expect((call.args.p_items as { line_total: number }[])[0].line_total).toBe(56);

    const [accountId, kind, target, ticket] = mocks.enqueueSalaoPrint.mock.calls[0];
    expect([accountId, kind, target]).toEqual(['acc-1', 'salao_round', 'cozinha']);
    expect(ticket).toMatchObject({ table_label: 'Mesa 12', round_number: 2, staff_name: 'Carlos' });
    expect(ticket.items).toHaveLength(1);
  });

  it('produto que não está no cardápio: recusa e não grava nada', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() } } });
    await expect(addRound(ctxWith(db), 'tab-1', [{ product_id: 'inventado', quantity: 1 }])).rejects.toMatchObject({ status: 400, code: 'unknown_product' });
    expect(db.rpcCalls).toHaveLength(0);
    expect(mocks.enqueueSalaoPrint).not.toHaveBeenCalled();
  });

  it('grupo obrigatório sem escolha: recusa com mensagem em português', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() } } });
    await expect(addRound(ctxWith(db), 'tab-1', [{ product_id: 'p-carne', quantity: 1 }])).rejects.toMatchObject({
      code: 'addon_group_invalid',
      message: 'Prato do dia: escolha uma opção em "Ponto".',
    });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('comanda já fechada: 409 e nada é impresso', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow({ status: 'closed' }) } } });
    await expect(addRound(ctxWith(db), 'tab-1', [{ product_id: 'p-marmita', quantity: 1 }])).rejects.toMatchObject({ status: 409, code: 'tab_not_open' });
    expect(mocks.enqueueSalaoPrint).not.toHaveBeenCalled();
  });

  it('comanda de outra conta (não achada pelo filtro de conta): 404', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: null } } });
    await expect(addRound(ctxWith(db), 'tab-de-outra-conta', [{ product_id: 'p-marmita', quantity: 1 }])).rejects.toMatchObject({ status: 404 });
  });

  it('impressão desligada: a rodada vale, mas avisa que não imprimiu', async () => {
    mocks.enqueueSalaoPrint.mockResolvedValue({ queued: false });
    const db = fakeDb({
      one: { salao_tabs: { data: tabRow() } },
      rpc: { salao_add_round: () => ({ data: { round_id: 'r1', round_number: 1 }, error: null }) },
    });
    expect((await addRound(ctxWith(db), 'tab-1', [{ product_id: 'p-marmita', quantity: 1 }])).printed).toBe(false);
  });

  it('erro do banco vira erro traduzido', async () => {
    const db = fakeDb({
      one: { salao_tabs: { data: tabRow() } },
      rpc: { salao_add_round: () => ({ data: null, error: { message: 'tab_not_open' } }) },
    });
    await expect(addRound(ctxWith(db), 'tab-1', [{ product_id: 'p-marmita', quantity: 1 }])).rejects.toMatchObject({ code: 'tab_not_open' });
    expect(mocks.enqueueSalaoPrint).not.toHaveBeenCalled();
  });
});

describe('closeTab', () => {
  const cash = { data: { id: 'cash-1', status: 'open', opening_float: 100, opened_by_name: 'Marta', opened_at: 'x' } };

  it('exige caixa aberto quando a conta configurou assim', async () => {
    const db = fakeDb({ one: { cash_sessions: { data: null } } });
    await expect(closeTab(ctxWith(db), 'tab-1', [{ method: 'pix', amount: 110 }])).rejects.toMatchObject({ status: 409, code: 'cash_closed' });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('com a regra desligada, fecha sem sessão de caixa', async () => {
    const db = fakeDb({
      one: { cash_sessions: { data: null } },
      rpc: { salao_close_tab: () => ({ data: { tab_id: 'tab-1', total: 110 }, error: null }) },
    });
    const ctx = ctxWith(db, { settings: { service_fee_percent: 10, service_fee_default_on: true, require_open_cash: false, permissions: {} } });
    await closeTab(ctx, 'tab-1', [{ method: 'pix', amount: 110 }]);
    expect(db.rpcCalls[0].args.p_cash_session_id).toBeNull();
  });

  it('passa os pagamentos e a sessão do caixa; devolve o troco', async () => {
    const db = fakeDb({
      one: { cash_sessions: cash },
      rpc: { salao_close_tab: () => ({ data: { tab_id: 'tab-1', total: 110 }, error: null }) },
    });
    const res = await closeTab(ctxWith(db), 'tab-1', [
      { method: 'pix', amount: 70 },
      { method: 'cash', amount: 40, tendered: 50 },
    ]);
    expect(res).toEqual({ tab_id: 'tab-1', total: 110, change: 10 });
    expect(db.rpcCalls[0].args).toMatchObject({ p_tab_id: 'tab-1', p_cash_session_id: 'cash-1', p_staff_name: 'Carlos' });
  });

  it('pagamento inválido nem chega ao banco', async () => {
    const db = fakeDb({ one: { cash_sessions: cash } });
    await expect(closeTab(ctxWith(db), 'tab-1', [{ method: 'pix', amount: -1 }])).rejects.toMatchObject({ code: 'invalid_payments' });
    await expect(closeTab(ctxWith(db), 'tab-1', undefined)).rejects.toMatchObject({ code: 'invalid_payments' });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('soma que não bate: traduz o erro do banco', async () => {
    const db = fakeDb({
      one: { cash_sessions: cash },
      rpc: { salao_close_tab: () => ({ data: null, error: { message: 'payments_mismatch' } }) },
    });
    await expect(closeTab(ctxWith(db), 'tab-1', [{ method: 'pix', amount: 50 }])).rejects.toMatchObject({ status: 409, code: 'payments_mismatch' });
  });
});

describe('cancelItem', () => {
  const item = { id: 'it-1', tab_id: 'tab-1', product_name: 'Marmita P', quantity: 2, unit_price: 28, line_total: 56, addons_snapshot: [], notes: null, status: 'active' };

  it('cancela e avisa a cozinha com o motivo e o garçom', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() }, salao_tab_items: { data: item } } });
    const res = await cancelItem(ctxWith(db), 'tab-1', 'it-1', '  cliente desistiu ');
    expect(res.printed).toBe(true);
    expect(db.rpcCalls[0].args).toMatchObject({ p_item_id: 'it-1', p_reason: 'cliente desistiu', p_staff_name: 'Carlos' });
    const [, kind, target, ticket] = mocks.enqueueSalaoPrint.mock.calls[0];
    expect([kind, target]).toEqual(['salao_item_cancel', 'cozinha']);
    expect(ticket).toMatchObject({ table_label: 'Mesa 12', reason: 'cliente desistiu' });
  });

  it('item de OUTRA comanda não pode ser cancelado por esta rota', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() }, salao_tab_items: { data: { ...item, tab_id: 'outra-comanda' } } } });
    await expect(cancelItem(ctxWith(db), 'tab-1', 'it-1', 'x')).rejects.toMatchObject({ status: 404, code: 'item_not_found' });
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe('requestBill', () => {
  it('imprime a pré-conta na impressora do caixa, sem os itens cancelados', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow({ status: 'bill_requested' }) } } });
    const res = await requestBill(ctxWith(db), 'tab-1');
    expect(res.printed).toBe(true);
    const [, kind, target, ticket] = mocks.enqueueSalaoPrint.mock.calls[0];
    expect([kind, target]).toEqual(['salao_bill', 'caixa']);
    expect(ticket).toMatchObject({ table_label: 'Mesa 12', guests: 4, total: 110, per_person: 27.5 });
  });

  it('comanda fechada não gera pré-conta', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow({ status: 'closed' }) } } });
    await expect(requestBill(ctxWith(db), 'tab-1')).rejects.toMatchObject({ code: 'tab_not_open' });
    expect(mocks.enqueueSalaoPrint).not.toHaveBeenCalled();
  });
});

describe('openTab', () => {
  it('devolve a comanda que já está aberta na mesa', async () => {
    const db = fakeDb({ one: { salao_tables: { data: { id: 'tbl-1', number: 12 } }, salao_tabs: { data: tabRow() } } });
    const res = await openTab(ctxWith(db), { tableId: 'tbl-1', guests: 2, customerName: null });
    expect(res.existing).toBe(true);
    expect(db.inserts).toHaveLength(0);
  });

  it('mesa de outra conta/inexistente: 404', async () => {
    const db = fakeDb({ one: { salao_tables: { data: null } } });
    await expect(openTab(ctxWith(db), { tableId: 'x', guests: 1, customerName: null })).rejects.toMatchObject({ status: 404, code: 'table_not_found' });
  });

  it('abre com a taxa de serviço da conta e o nome de quem abriu', async () => {
    let call = 0;
    const db = fakeDb({
      one: {
        salao_tables: { data: { id: 'tbl-1', number: 12 } },
        // 1ª consulta (procura aberta): nada; depois do insert, o próprio insert responde
        salao_tabs: () => (call++ === 0 ? { data: null } : { data: null }),
      },
      insert: { salao_tabs: (p) => ({ data: { ...tabRow(), ...(p as object) }, error: null }) },
    });
    const res = await openTab(ctxWith(db), { tableId: 'tbl-1', guests: 3, customerName: null });
    expect(res.existing).toBe(false);
    expect(db.inserts[0].payload).toMatchObject({
      account_id: 'acc-1', table_id: 'tbl-1', label: 'Mesa 12', guests: 3,
      opened_by_name: 'Carlos', service_fee_enabled: true, service_fee_percent: 10,
    });
  });

  it('dois garçons na mesma mesa ao mesmo tempo: o índice decide e o perdedor recebe a comanda do vencedor', async () => {
    let lookups = 0;
    const winner = tabRow({ id: 'tab-vencedora' });
    const db = fakeDb({
      one: {
        salao_tables: { data: { id: 'tbl-1', number: 12 } },
        salao_tabs: () => (lookups++ === 0 ? { data: null } : { data: winner }),
      },
      insert: { salao_tabs: () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }) },
    });
    const res = await openTab(ctxWith(db), { tableId: 'tbl-1', guests: 2, customerName: null });
    expect(res).toMatchObject({ existing: true, tab: { id: 'tab-vencedora' } });
  });

  it('venda de balcão: sem mesa e sem taxa de serviço', async () => {
    const db = fakeDb({
      count: { salao_tabs: 2 },
      insert: { salao_tabs: (p) => ({ data: { ...tabRow(), ...(p as object) }, error: null }) },
    });
    await openTab(ctxWith(db), { tableId: null, guests: 1, customerName: 'João' });
    expect(db.inserts[0].payload).toMatchObject({ table_id: null, label: 'Balcão 3', service_fee_enabled: false, customer_name: 'João' });
  });
});

describe('updateTab', () => {
  it('desconto maior que a conta é recusado', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() } } });
    await expect(updateTab(ctxWith(db), 'tab-1', { discount_amount: 500 })).rejects.toMatchObject({ code: 'invalid_discount' });
  });

  it('desconto negativo ou texto é recusado', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() } } });
    await expect(updateTab(ctxWith(db), 'tab-1', { discount_amount: -1 })).rejects.toMatchObject({ code: 'invalid_discount' });
    await expect(updateTab(ctxWith(db), 'tab-1', { discount_amount: Number.NaN })).rejects.toMatchObject({ code: 'invalid_discount' });
  });

  it('comanda fechada não muda', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow({ status: 'closed' }) } } });
    await expect(updateTab(ctxWith(db), 'tab-1', { guests: 5 })).rejects.toMatchObject({ code: 'tab_not_open' });
  });

  it('desconto válido recalcula a comanda no banco', async () => {
    const db = fakeDb({ one: { salao_tabs: { data: tabRow() } } });
    await updateTab(ctxWith(db), 'tab-1', { discount_amount: 10 });
    expect(db.rpcCalls[0]).toMatchObject({ fn: 'salao_recalc_tab', args: { p_tab: 'tab-1' } });
  });
});
