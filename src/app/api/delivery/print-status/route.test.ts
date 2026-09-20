import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, getCurrentAccount: h.getCurrentAccount }
})

function fakeSupabase(opts: {
  config?: { enabled: boolean; last_polled_at: string | null } | null
  jobs?: { created_at: string }[]
  count?: number
  error?: unknown
}) {
  return {
    from: (table: string) => {
      if (table === 'print_configs') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.config ?? null, error: opts.error ?? null }) }),
          }),
        }
      }
      const chain = {
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({ data: opts.jobs ?? [], count: opts.count ?? opts.jobs?.length ?? 0, error: null }),
      }
      return { select: () => chain }
    },
  }
}

import { GET } from './route'

beforeEach(() => vi.clearAllMocks())

describe('GET /api/delivery/print-status', () => {
  it('flags needsAttention when the agent is silent and orders are waiting', async () => {
    const stale = new Date(Date.now() - 201 * 60_000).toISOString()
    h.getCurrentAccount.mockResolvedValue({
      supabase: fakeSupabase({
        config: { enabled: true, last_polled_at: stale },
        jobs: [{ created_at: '2026-09-20T14:29:00Z' }],
        count: 11,
      }),
      accountId: 'acc-1',
    })
    const body = await (await GET()).json()
    expect(body).toMatchObject({
      enabled: true,
      online: false,
      needsAttention: true,
      pendingCount: 11,
      oldest_pending_at: '2026-09-20T14:29:00Z',
      last_polled_at: stale,
    })
  })

  it('is healthy when the agent polled seconds ago', async () => {
    h.getCurrentAccount.mockResolvedValue({
      supabase: fakeSupabase({ config: { enabled: true, last_polled_at: new Date(Date.now() - 4000).toISOString() }, count: 3 }),
      accountId: 'acc-1',
    })
    const body = await (await GET()).json()
    expect(body).toMatchObject({ online: true, needsAttention: false })
  })

  it('treats an account without a print_configs row as auto-print off (never alerts)', async () => {
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ config: null, count: 9 }), accountId: 'acc-1' })
    const body = await (await GET()).json()
    expect(body).toMatchObject({ enabled: false, needsAttention: false })
  })

  it('500s on a DB error', async () => {
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ error: { message: 'boom' } }), accountId: 'acc-1' })
    expect((await GET()).status).toBe(500)
  })
})
