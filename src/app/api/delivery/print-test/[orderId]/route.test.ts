import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}));

import { GET } from './route';

function makeDb(job: Record<string, unknown> | null) {
  let lastAccountId: string | undefined;
  const db = {
    from: (table: string) => {
      if (table === 'print_jobs') {
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (col === 'account_id') lastAccountId = val;
            return chain;
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: job, error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { db, getLastAccountId: () => lastAccountId };
}

function params(orderId: string) {
  return { params: Promise.resolve({ orderId }) };
}

beforeEach(() => {
  mocks.requireRole.mockReset();
});

describe('GET /api/delivery/print-test/[orderId]', () => {
  it('returns the print_jobs row status, scoped to the caller\'s own account', async () => {
    const { db, getLastAccountId } = makeDb({
      status: 'printed',
      error: null,
      printed_at: '2026-09-07T10:00:00.000Z',
      claimed_at: '2026-09-07T09:59:58.000Z',
    });
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(new Request('http://localhost'), params('order-1'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe('printed');
    expect(data.printed_at).toBe('2026-09-07T10:00:00.000Z');
    expect(getLastAccountId()).toBe('acct-1');
  });

  it('returns 404 when no print_jobs row exists for that order/account', async () => {
    const { db } = makeDb(null);
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(new Request('http://localhost'), params('order-does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('reports pending/failed states as-is, including the error text', async () => {
    const { db } = makeDb({ status: 'failed', error: 'Impressora reportou problema: sem papel.', printed_at: null, claimed_at: '2026-09-07T09:59:58.000Z' });
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1' });

    const res = await GET(new Request('http://localhost'), params('order-1'));
    const data = await res.json();
    expect(data.status).toBe('failed');
    expect(data.error).toBe('Impressora reportou problema: sem papel.');
  });
});
