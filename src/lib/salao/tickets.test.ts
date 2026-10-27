import { describe, expect, it } from 'vitest';
import {
  buildBillTicket,
  buildItemCancelTicket,
  buildRoundTicket,
  normalizeDeliveryMethod,
  perPerson,
  summarizeDelivery,
  summarizePayments,
} from './tickets';

const item = {
  product_name: 'Marmita P',
  quantity: 2,
  unit_price: 28,
  line_total: 56,
  addons_snapshot: [{ group_name: 'Carne', option_name: 'Churrasco' }],
  notes: 'sem cebola',
};

describe('tickets da cozinha', () => {
  it('rodada: leva a mesa, o garçom, a rodada e só os itens enviados', () => {
    const t = buildRoundTicket({
      tableLabel: 'Mesa 12',
      roundNumber: 3,
      staffName: 'Carlos',
      guests: 4,
      createdAt: '2026-10-27T15:00:00Z',
      items: [item],
    });
    expect(t).toMatchObject({ type: 'salao_round', table_label: 'Mesa 12', round_number: 3, staff_name: 'Carlos' });
    expect(t.items).toHaveLength(1);
    expect(t.items[0].notes).toBe('sem cebola');
  });

  it('cancelamento de item: leva o motivo e quem cancelou', () => {
    const t = buildItemCancelTicket({
      tableLabel: 'Mesa 3',
      staffName: 'Ana',
      reason: 'cliente desistiu',
      createdAt: '2026-10-27T15:00:00Z',
      item,
    });
    expect(t).toMatchObject({ type: 'salao_item_cancel', reason: 'cliente desistiu', staff_name: 'Ana' });
    expect(t.item.product_name).toBe('Marmita P');
  });

  it('tolera item sem adicionais/observação', () => {
    const t = buildRoundTicket({
      tableLabel: 'Mesa 1', roundNumber: 1, staffName: 'x', guests: null, createdAt: 'z',
      items: [{ product_name: 'Água', quantity: 1, unit_price: 3, line_total: 3 }],
    });
    expect(t.items[0]).toMatchObject({ addons_snapshot: [], notes: null });
  });
});

describe('pré-conta', () => {
  const base = {
    tableLabel: 'Mesa 12', guests: 4, openedAt: 'a', createdAt: 'b', currency: 'BRL',
    items: [item], subtotal: 100, serviceFeeEnabled: true, serviceFeePercent: 10,
    serviceFeeAmount: 10, discountAmount: 0, total: 110,
  };

  it('divide o total pelas pessoas', () => {
    expect(buildBillTicket(base).per_person).toBe(27.5);
  });

  it('não imprime valor por pessoa para uma pessoa só', () => {
    expect(buildBillTicket({ ...base, guests: 1 }).per_person).toBeNull();
  });

  it('sem taxa de serviço, o percentual some do ticket', () => {
    const t = buildBillTicket({ ...base, serviceFeeEnabled: false, serviceFeeAmount: 0, total: 100 });
    expect(t.service_fee_percent).toBeNull();
    expect(t.service_fee_amount).toBe(0);
  });

  it('arredonda o valor por pessoa para centavos', () => {
    expect(perPerson(100, 3)).toBe(33.33);
  });
});

describe('delivery no fechamento do caixa', () => {
  it.each([
    ['Pix', 'pix'],
    ['PIX na entrega', 'pix'],
    ['dinheiro', 'cash'],
    ['Dinheiro (troco para 100)', 'cash'],
    ['Cartão na entrega', 'card'],
    ['cartão de crédito', 'card'],
    ['débito', 'card'],
    ['vale refeição', 'other'],
    ['', 'unknown'],
    [null, 'unknown'],
  ])('"%s" vira %s', (raw, expected) => {
    expect(normalizeDeliveryMethod(raw as string | null)).toBe(expected);
  });

  it('soma por forma de pagamento sem perder centavos', () => {
    const s = summarizeDelivery([
      { total: 36.1, payment_method: 'Pix' },
      { total: 20.2, payment_method: 'pix' },
      { total: 42, payment_method: 'Dinheiro' },
      { total: 15, payment_method: null },
    ]);
    expect(s.count).toBe(4);
    expect(s.total).toBe(113.3);
    expect(s.byMethod.pix).toEqual({ count: 2, total: 56.3 });
    expect(s.byMethod.cash.total).toBe(42);
    expect(s.byMethod.unknown.count).toBe(1);
  });

  it('soma os pagamentos do salão por forma', () => {
    expect(
      summarizePayments([
        { method: 'pix', amount: 50.1 },
        { method: 'pix', amount: 10.2 },
        { method: 'cash', amount: 30 },
        { method: 'qualquer', amount: 5 },
      ]),
    ).toEqual({ pix: 60.3, credit: 0, debit: 0, cash: 30, other: 5 });
  });
});
