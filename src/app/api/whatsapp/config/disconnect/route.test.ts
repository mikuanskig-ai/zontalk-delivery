import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  logoutSession: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})
vi.mock('@/lib/whatsapp/wuzapi-api', () => ({ logoutSession: h.logoutSession }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `decrypted:${v}` }))

function fakeSupabase(opts: {
  config?: { data: unknown; error: unknown }
  updateError?: unknown
}) {
  const updateCalls: unknown[] = []
  return {
    updateCalls,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve(opts.config ?? { data: null, error: null }),
          }),
        }),
        update: (payload: unknown) => {
          updateCalls.push(payload)
          return { eq: () => Promise.resolve({ error: opts.updateError ?? null }) }
        },
      }),
    },
  }
}

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockImplementation(async () => {
    const { supabase } = fakeSupabase({
      config: { data: { id: 'wc-1', wuzapi_base_url: 'https://wuzapi.example', wuzapi_token: 'enc-token' }, error: null },
    })
    return { supabase, accountId: 'acct-1', userId: 'user-1' }
  })
  h.logoutSession.mockResolvedValue(undefined)
})

describe('POST /api/whatsapp/config/disconnect', () => {
  it('propagates the role gate (403) when the caller is not admin+', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await POST()
    expect(res.status).toBe(403)
  })

  it('404s when no WhatsApp channel is configured for the account', async () => {
    const { supabase } = fakeSupabase({ config: { data: null, error: null } })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await POST()
    expect(res.status).toBe(404)
  })

  it('logs the wuzapi session out, marks the channel disconnected, and keeps the row (no delete)', async () => {
    const { supabase, updateCalls } = fakeSupabase({
      config: { data: { id: 'wc-1', wuzapi_base_url: 'https://wuzapi.example', wuzapi_token: 'enc-token' }, error: null },
    })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    expect(h.logoutSession).toHaveBeenCalledWith({
      baseUrl: 'https://wuzapi.example',
      token: 'decrypted:enc-token',
    })
    expect(updateCalls).toEqual([{ status: 'disconnected', connected_at: null }])
  })

  it('keeps going and still marks the channel disconnected when the wuzapi logout call itself fails', async () => {
    h.logoutSession.mockRejectedValue(new Error('wuzapi unreachable'))
    const { supabase, updateCalls } = fakeSupabase({
      config: { data: { id: 'wc-1', wuzapi_base_url: 'https://wuzapi.example', wuzapi_token: 'enc-token' }, error: null },
    })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST()
    expect(res.status).toBe(200)
    expect(updateCalls).toEqual([{ status: 'disconnected', connected_at: null }])
  })

  it('surfaces a 500 when the status update fails', async () => {
    const { supabase } = fakeSupabase({
      config: { data: { id: 'wc-1', wuzapi_base_url: 'https://wuzapi.example', wuzapi_token: 'enc-token' }, error: null },
      updateError: { message: 'boom' },
    })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST()
    expect(res.status).toBe(500)
  })
})
