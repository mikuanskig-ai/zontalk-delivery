import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getMetaCapiPlatformCredentials: vi.fn(),
  sendMetaConversion: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})
vi.mock('@/lib/integrations/meta-capi/discover-assets', () => ({
  getMetaCapiPlatformCredentials: h.getMetaCapiPlatformCredentials,
}))
vi.mock('@/lib/integrations/meta-capi/send-conversion', () => ({
  sendMetaConversion: h.sendMetaConversion,
}))

function fakeSupabase(row: Record<string, unknown> | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  }
}

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.getMetaCapiPlatformCredentials.mockReturnValue({ systemUserToken: 'tok', businessId: 'biz-1' })
  h.sendMetaConversion.mockResolvedValue({ ok: true })
})

describe('POST /api/integrations/meta-capi/test', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await POST()
    expect(res.status).toBe(403)
  })

  it('400s when no pixel/waba has been linked yet', async () => {
    h.requireRole.mockResolvedValue({ supabase: fakeSupabase(null), accountId: 'acct-1', userId: 'user-1' })
    const res = await POST()
    expect(res.status).toBe(400)
  })

  it('400s when no test_event_code is set — the whole point of this endpoint requires it', async () => {
    h.requireRole.mockResolvedValue({
      supabase: fakeSupabase({ pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1', test_event_code: null }),
      accountId: 'acct-1',
      userId: 'user-1',
    })
    const res = await POST()
    expect(res.status).toBe(400)
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('503s when platform-level credentials are unset', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue(null)
    h.requireRole.mockResolvedValue({
      supabase: fakeSupabase({ pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1', test_event_code: 'TEST1' }),
      accountId: 'acct-1',
      userId: 'user-1',
    })
    const res = await POST()
    expect(res.status).toBe(503)
  })

  it('sends a synthetic test event using the linked pixel/waba and platform token', async () => {
    h.requireRole.mockResolvedValue({
      supabase: fakeSupabase({ pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1', test_event_code: 'TEST1' }),
      accountId: 'acct-1',
      userId: 'user-1',
    })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(h.sendMetaConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        pixelId: 'px-1',
        whatsappBusinessAccountId: 'waba-1',
        accessToken: 'tok',
        testEventCode: 'TEST1',
        ctwaClid: expect.stringMatching(/^test_/),
      }),
    )
  })

  it('502s and surfaces Meta\'s error when the test send fails', async () => {
    h.requireRole.mockResolvedValue({
      supabase: fakeSupabase({ pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1', test_event_code: 'TEST1' }),
      accountId: 'acct-1',
      userId: 'user-1',
    })
    h.sendMetaConversion.mockResolvedValue({ ok: false, retryable: false, error: 'invalid pixel' })
    const res = await POST()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'invalid pixel' })
  })
})
