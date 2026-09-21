import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn(), getCurrentAccount: vi.fn() }))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole, getCurrentAccount: h.getCurrentAccount }
})

function fakeSupabase(opts: { existing?: { id: string } | null; row?: Record<string, unknown> | null; updateError?: unknown }) {
  const updates: Record<string, unknown>[] = []
  return {
    updates,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.row !== undefined ? opts.row : (opts.existing ?? null), error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          updates.push(payload)
          return { eq: () => Promise.resolve({ error: opts.updateError ?? null }) }
        },
      }),
    },
  }
}

import { GET, POST } from './route'

const GOOD = {
  followup_enabled: true,
  followup_delay_minutes: 20,
  followup_max: 2,
  followup_messages: ['Oi {nome}!', '', ''],
  followup_close_minutes: 120,
  auto_close_after_order_minutes: 20,
}

let seq = 0
function asAdmin(supabase: unknown) {
  h.requireRole.mockResolvedValue({ supabase, accountId: 'acc-1', userId: `u-${++seq}` })
}
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ai/followup', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => vi.clearAllMocks())

describe('GET /api/ai/followup', () => {
  it('reports configured:false (with the default texts) when AI is not set up', async () => {
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ row: null }).supabase, accountId: 'acc-1' })
    const body = await (await GET()).json()
    expect(body.configured).toBe(false)
    expect(body.default_messages).toHaveLength(3)
  })

  it('returns the resolved settings and only what the admin typed as messages', async () => {
    h.getCurrentAccount.mockResolvedValue({
      supabase: fakeSupabase({
        row: {
          followup_enabled: true,
          followup_delay_minutes: 30,
          followup_max: 2,
          followup_messages: ['Oi!', ''],
          followup_close_minutes: 60,
          auto_close_after_order_minutes: 15,
        },
      }).supabase,
      accountId: 'acc-1',
    })
    const body = await (await GET()).json()
    expect(body).toMatchObject({
      configured: true,
      followup_enabled: true,
      followup_delay_minutes: 30,
      followup_max: 2,
      followup_messages: ['Oi!', ''],
      followup_close_minutes: 60,
      auto_close_after_order_minutes: 15,
    })
  })
})

describe('POST /api/ai/followup', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    expect((await post(GOOD)).status).toBe(403)
  })

  it.each([
    ['delay too small', { ...GOOD, followup_delay_minutes: 1 }],
    ['delay not a number', { ...GOOD, followup_delay_minutes: 'x' }],
    ['max above 3', { ...GOOD, followup_max: 4 }],
    ['negative close', { ...GOOD, followup_close_minutes: -1 }],
    ['auto-close out of range', { ...GOOD, auto_close_after_order_minutes: 9999 }],
    ['too many messages', { ...GOOD, followup_messages: ['a', 'b', 'c', 'd'] }],
    ['message too long', { ...GOOD, followup_messages: ['x'.repeat(601)] }],
  ])('400s on %s', async (_n, body) => {
    asAdmin(fakeSupabase({ existing: { id: 'cfg-1' } }).supabase)
    expect((await post(body)).status).toBe(400)
  })

  it('400s when the AI is not configured yet (no ai_configs row)', async () => {
    asAdmin(fakeSupabase({ existing: null }).supabase)
    expect((await post(GOOD)).status).toBe(400)
  })

  it('saves the settings, trimming trailing blank messages and turning empty auto-close into null', async () => {
    const { supabase, updates } = fakeSupabase({ existing: { id: 'cfg-1' } })
    asAdmin(supabase)
    const res = await post({ ...GOOD, followup_messages: ['  Oi!  ', '', ''], auto_close_after_order_minutes: '' })
    expect(res.status).toBe(200)
    expect(updates[0]).toEqual({
      followup_enabled: true,
      followup_delay_minutes: 20,
      followup_max: 2,
      followup_messages: ['Oi!'],
      followup_close_minutes: 120,
      auto_close_after_order_minutes: null,
    })
  })

  it('500s on a DB error', async () => {
    asAdmin(fakeSupabase({ existing: { id: 'cfg-1' }, updateError: { message: 'boom' } }).supabase)
    expect((await post(GOOD)).status).toBe(500)
  })
})
