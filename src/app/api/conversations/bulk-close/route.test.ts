import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn() }))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function fakeSupabase(opts: { error?: unknown } = {}) {
  const calls: { payload: Record<string, unknown>; ids: string[]; accountId?: string; neq?: [string, string] }[] = []
  return {
    calls,
    supabase: {
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          const call: (typeof calls)[number] = { payload, ids: [] }
          calls.push(call)
          const chain = {
            in: (_c: string, ids: string[]) => ((call.ids = ids), chain),
            eq: (_c: string, v: string) => ((call.accountId = v), chain),
            neq: (c: string, v: string) => ((call.neq = [c, v]), chain),
            select: () =>
              Promise.resolve(
                opts.error ? { data: null, error: opts.error } : { data: call.ids.map((id) => ({ id })), error: null },
              ),
          }
          return chain
        },
      }),
    },
  }
}

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://localhost/api/conversations/bulk-close', { method: 'POST', body: JSON.stringify(body) })
}

let userSeq = 0
function asAgent(supabase: unknown) {
  // unique userId per test so the in-memory rate limiter never interferes
  h.requireRole.mockResolvedValue({ supabase, accountId: 'acc-1', userId: `user-${++userSeq}` })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/conversations/bulk-close', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'agent' role or higher"))
    expect((await POST(req({ conversation_ids: [ID(1)] }))).status).toBe(403)
  })

  it.each([
    ['missing', {}],
    ['empty', { conversation_ids: [] }],
    ['not uuids', { conversation_ids: ['abc'] }],
    ['not strings', { conversation_ids: [1, 2] }],
  ])('400s when conversation_ids is %s', async (_n, body) => {
    asAgent(fakeSupabase().supabase)
    expect((await POST(req(body))).status).toBe(400)
  })

  it('400s above 1000 ids', async () => {
    asAgent(fakeSupabase().supabase)
    const ids = Array.from({ length: 1001 }, (_, i) => ID(i))
    expect((await POST(req({ conversation_ids: ids }))).status).toBe(400)
  })

  it('closes with audit stamps, scoped to the account, skipping already-closed', async () => {
    const { supabase, calls } = fakeSupabase()
    asAgent(supabase)
    const res = await POST(req({ conversation_ids: [ID(1), ID(2)] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, closed: 2, closed_ids: [ID(1), ID(2)] })
    expect(calls).toHaveLength(1)
    expect(calls[0].accountId).toBe('acc-1')
    expect(calls[0].neq).toEqual(['status', 'closed'])
    expect(calls[0].payload).toMatchObject({ status: 'closed', closed_by: expect.stringMatching(/^user-/), close_reason: 'bulk_close' })
  })

  it('chunks large batches (200 per update)', async () => {
    const { supabase, calls } = fakeSupabase()
    asAgent(supabase)
    const ids = Array.from({ length: 450 }, (_, i) => ID(i))
    const res = await POST(req({ conversation_ids: ids }))
    expect((await res.json()).closed).toBe(450)
    expect(calls.map((c) => c.ids.length)).toEqual([200, 200, 50])
  })

  it('500s on a DB error', async () => {
    asAgent(fakeSupabase({ error: { message: 'boom' } }).supabase)
    expect((await POST(req({ conversation_ids: [ID(1)] }))).status).toBe(500)
  })
})
