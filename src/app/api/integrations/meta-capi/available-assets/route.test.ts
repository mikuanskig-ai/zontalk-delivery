import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getMetaCapiPlatformCredentials: vi.fn(),
  discoverSharedAssets: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})
vi.mock('@/lib/integrations/meta-capi/discover-assets', () => ({
  getMetaCapiPlatformCredentials: h.getMetaCapiPlatformCredentials,
  discoverSharedAssets: h.discoverSharedAssets,
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ supabase: {}, accountId: 'acct-1', userId: 'user-1' })
})

describe('GET /api/integrations/meta-capi/available-assets', () => {
  it('propagates the role gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('503s when the platform-level credentials are unset', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue(null)
    const res = await GET()
    expect(res.status).toBe(503)
  })

  it('502s and surfaces the error when discovery fails', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue({ systemUserToken: 'tok', businessId: 'biz-1' })
    h.discoverSharedAssets.mockResolvedValue({ ok: false, error: 'client_pixels: Invalid OAuth access token' })
    const res = await GET()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'client_pixels: Invalid OAuth access token' })
  })

  it('returns the discovered pixels and WhatsApp Business Accounts', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue({ systemUserToken: 'tok', businessId: 'biz-1' })
    h.discoverSharedAssets.mockResolvedValue({
      ok: true,
      pixels: [{ id: 'px-1', name: 'Loja' }],
      whatsappBusinessAccounts: [{ id: 'waba-1', name: 'WABA' }],
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      pixels: [{ id: 'px-1', name: 'Loja' }],
      whatsapp_business_accounts: [{ id: 'waba-1', name: 'WABA' }],
    })
  })
})
