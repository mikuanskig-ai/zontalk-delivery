import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn() }))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})

function fakeSupabase(opts: { existing?: { id: string } | null; writeError?: unknown }) {
  const calls: { op: 'insert' | 'update'; payload: unknown }[] = []
  return {
    calls,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.existing ?? null, error: null }),
          }),
        }),
        insert: (payload: unknown) => {
          calls.push({ op: 'insert', payload })
          return Promise.resolve({ error: opts.writeError ?? null })
        },
        update: (payload: unknown) => {
          calls.push({ op: 'update', payload })
          return { eq: () => Promise.resolve({ error: opts.writeError ?? null }) }
        },
      }),
    },
  }
}

import { POST } from './route'

const VALID_BODY = {
  pixel_id: 'px-1',
  pixel_name: 'Loja',
  whatsapp_business_account_id: 'waba-1',
  whatsapp_business_account_name: 'WABA',
}

function req(body: unknown) {
  return new Request('http://localhost/api/integrations/meta-capi/link', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/integrations/meta-capi/link', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(403)
  })

  it.each(['pixel_id', 'pixel_name', 'whatsapp_business_account_id', 'whatsapp_business_account_name'])(
    '400s when %s is missing',
    async (field) => {
      const { supabase } = fakeSupabase({ existing: null })
      h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
      const res = await POST(req({ ...VALID_BODY, [field]: '' }))
      expect(res.status).toBe(400)
    },
  )

  it('inserts a new row (with linked_at/linked_by/is_active) when none existed', async () => {
    const { supabase, calls } = fakeSupabase({ existing: null })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      op: 'insert',
      payload: expect.objectContaining({
        account_id: 'acct-1',
        pixel_id: 'px-1',
        is_active: true,
        linked_by: 'user-1',
      }),
    })
  })

  it('updates the existing row instead of inserting a duplicate', async () => {
    const { supabase, calls } = fakeSupabase({ existing: { id: 'row-1' } })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].op).toBe('update')
  })

  it('surfaces a 500 when the write fails', async () => {
    const { supabase } = fakeSupabase({ existing: null, writeError: { message: 'boom' } })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(500)
  })
})
