import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  getMetaCapiPlatformCredentials: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, getCurrentAccount: h.getCurrentAccount, requireRole: h.requireRole }
})
vi.mock('@/lib/integrations/meta-capi/discover-assets', () => ({
  getMetaCapiPlatformCredentials: h.getMetaCapiPlatformCredentials,
}))

function fakeSupabase(opts: { row?: Record<string, unknown> | null; updateError?: unknown }) {
  const updateCalls: unknown[] = []
  return {
    updateCalls,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.row ?? null, error: null }),
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

import { GET, PATCH, DELETE } from './route'

function patchReq(body: unknown) {
  return new Request('http://localhost/api/integrations/meta-capi', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ row: null }).supabase, accountId: 'acct-1' })
  h.requireRole.mockResolvedValue({ supabase: fakeSupabase({ row: null }).supabase, accountId: 'acct-1', userId: 'user-1' })
  h.getMetaCapiPlatformCredentials.mockReturnValue({ systemUserToken: 'tok', businessId: 'biz-1' })
})

describe('GET /api/integrations/meta-capi', () => {
  it('returns configured:false + platform readiness when no row exists', async () => {
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ row: null }).supabase, accountId: 'acct-1' })
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({ configured: false, platform_ready: true, platform_business_id: 'biz-1' })
  })

  it('reports platform_ready:false when platform credentials are unset', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue(null)
    const res = await GET()
    const body = await res.json()
    expect(body).toMatchObject({ platform_ready: false, platform_business_id: null })
  })

  it('returns the linked row when one exists', async () => {
    const row = { pixel_id: 'px-1', pixel_name: 'Loja', whatsapp_business_account_id: 'waba-1', whatsapp_business_account_name: 'WABA', is_active: true, test_event_code: null, linked_at: '2026-09-18T00:00:00Z' }
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase({ row }).supabase, accountId: 'acct-1' })
    const res = await GET()
    const body = await res.json()
    expect(body).toMatchObject({ configured: true, pixel_id: 'px-1', is_active: true })
  })
})

describe('PATCH /api/integrations/meta-capi', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await PATCH(patchReq({ is_active: true }))
    expect(res.status).toBe(403)
  })

  it('400s when neither is_active nor test_event_code is present', async () => {
    h.requireRole.mockResolvedValue({ supabase: fakeSupabase({ row: { pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1' } }).supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(400)
  })

  it('400s when no pixel/waba has been linked yet', async () => {
    h.requireRole.mockResolvedValue({ supabase: fakeSupabase({ row: null }).supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await PATCH(patchReq({ is_active: true }))
    expect(res.status).toBe(400)
  })

  it('patches only is_active when that is the only field sent', async () => {
    const { supabase, updateCalls } = fakeSupabase({ row: { pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1' } })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await PATCH(patchReq({ is_active: true }))
    expect(res.status).toBe(200)
    expect(updateCalls).toEqual([{ is_active: true }])
  })

  it('normalizes an empty test_event_code string to null', async () => {
    const { supabase, updateCalls } = fakeSupabase({ row: { pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1' } })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await PATCH(patchReq({ test_event_code: '  ' }))
    expect(res.status).toBe(200)
    expect(updateCalls).toEqual([{ test_event_code: null }])
  })
})

describe('DELETE /api/integrations/meta-capi', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await DELETE()
    expect(res.status).toBe(403)
  })

  it('clears the linked pixel/waba and deactivates', async () => {
    const { supabase, updateCalls } = fakeSupabase({ row: {} })
    h.requireRole.mockResolvedValue({ supabase, accountId: 'acct-1', userId: 'user-1' })
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(updateCalls).toEqual([
      {
        pixel_id: null,
        pixel_name: null,
        whatsapp_business_account_id: null,
        whatsapp_business_account_name: null,
        is_active: false,
        linked_at: null,
        linked_by: null,
      },
    ])
  })
})
