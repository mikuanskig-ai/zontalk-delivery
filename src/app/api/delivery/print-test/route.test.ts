import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  finalizeDeliveryOrder: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}));
vi.mock('@/lib/delivery/create-order', async () => {
  const actual = await vi.importActual<typeof import('@/lib/delivery/create-order')>('@/lib/delivery/create-order');
  return { ...actual, finalizeDeliveryOrder: mocks.finalizeDeliveryOrder };
});

import { POST } from './route';

function makeDb(defaultCurrency = 'BRL') {
  const db = {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { default_currency: defaultCurrency }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
  return db;
}

function request(body: unknown) {
  return new Request('http://localhost/api/delivery/print-test', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.finalizeDeliveryOrder.mockReset();
  mocks.finalizeDeliveryOrder.mockResolvedValue({ id: 'order-test-1' });
});

describe('POST /api/delivery/print-test', () => {
  it('rejects an empty items array', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    const res = await POST(request({ items: [] }));
    expect(res.status).toBe(400);
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled();
  });

  it('rejects an item with no product_name', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    const res = await POST(request({ items: [{ quantity: 1, unit_price: 10 }] }));
    expect(res.status).toBe(400);
  });

  it('calls finalizeDeliveryOrder with skipSideEffects: true and a 🧪-prefixed default customer name', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    const res = await POST(request({ items: [{ product_name: 'Marmita P', quantity: 2, unit_price: 20 }] }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.order_id).toBe('order-test-1');
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: null,
        skipSideEffects: true,
        customerName: '🧪 Simulador de Impressão',
        cart: [
          expect.objectContaining({ product_id: '', product_name: 'Marmita P', quantity: 2, unit_price: 20 }),
        ],
      }),
    );
  });

  it('prefixes a custom customer_name with 🧪 instead of replacing it — never lets a test order look like a real one', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    await POST(request({ items: [{ product_name: 'Marmita P' }], customer_name: 'Cliente Teste' }));
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerName: '🧪 Cliente Teste' }),
    );
  });

  it('treats a present delivery_address as delivery, and an absent one as pickup — same rule as the real order/receipt', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    await POST(request({ items: [{ product_name: 'Marmita P' }], delivery_address: 'Rua X, 123' }));
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deliveryAddress: 'Rua X, 123' }),
    );

    await POST(request({ items: [{ product_name: 'Marmita P' }] }));
    expect(mocks.finalizeDeliveryOrder).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ deliveryAddress: null }),
    );
  });

  it('parses addons with a group_name, and clamps a negative/zero quantity up to 1', async () => {
    mocks.requireRole.mockResolvedValue({ supabase: makeDb(), accountId: 'acct-1', userId: 'user-1' });
    await POST(
      request({
        items: [
          {
            product_name: 'Refrigerante',
            quantity: -5,
            addons: [{ group_name: 'Sabor', option_name: 'Coca cola', price_delta: 0 }],
          },
        ],
      }),
    );
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cart: [
          expect.objectContaining({
            quantity: 1,
            addons: [expect.objectContaining({ group_name: 'Sabor', option_name: 'Coca cola' })],
          }),
        ],
      }),
    );
  });
});
