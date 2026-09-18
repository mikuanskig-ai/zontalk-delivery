import { describe, it, expect, vi, afterEach } from 'vitest'
import { getMetaCapiPlatformCredentials, discoverSharedAssets } from './discover-assets'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
})

describe('getMetaCapiPlatformCredentials', () => {
  it('returns null when either env var is unset — feature stays off, same "no row = off" convention as every other integration', () => {
    delete process.env.META_CAPI_SYSTEM_USER_TOKEN
    delete process.env.META_CAPI_BUSINESS_ID
    expect(getMetaCapiPlatformCredentials()).toBeNull()

    process.env.META_CAPI_SYSTEM_USER_TOKEN = 'tok'
    delete process.env.META_CAPI_BUSINESS_ID
    expect(getMetaCapiPlatformCredentials()).toBeNull()
  })

  it('returns both values when set', () => {
    process.env.META_CAPI_SYSTEM_USER_TOKEN = 'tok-1'
    process.env.META_CAPI_BUSINESS_ID = 'biz-1'
    expect(getMetaCapiPlatformCredentials()).toEqual({ systemUserToken: 'tok-1', businessId: 'biz-1' })
  })
})

const CREDS = { systemUserToken: 'tok-1', businessId: 'biz-1' }

describe('discoverSharedAssets', () => {
  it('fetches both client_pixels and client_whatsapp_business_accounts and returns them typed', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        calledUrls.push(url)
        if (url.includes('client_pixels')) {
          return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'px-1', name: 'Concórdia Pixel' }] }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'waba-1', name: 'Concórdia WhatsApp' }] }) })
      }),
    )

    const result = await discoverSharedAssets(CREDS)

    expect(result).toEqual({
      ok: true,
      pixels: [{ id: 'px-1', name: 'Concórdia Pixel' }],
      whatsappBusinessAccounts: [{ id: 'waba-1', name: 'Concórdia WhatsApp' }],
    })
    expect(calledUrls.some((u) => u.includes('/biz-1/client_pixels'))).toBe(true)
    expect(calledUrls.some((u) => u.includes('/biz-1/client_whatsapp_business_accounts'))).toBe(true)
  })

  it('drops malformed rows (missing id/name) rather than crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'ok-1', name: 'Fine' }, { id: 'no-name' }, {}] }) }),
    )
    const result = await discoverSharedAssets(CREDS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.pixels).toEqual([{ id: 'ok-1', name: 'Fine' }])
    }
  })

  it('surfaces Meta\'s own error message, prefixed by which edge failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) }),
    )
    const result = await discoverSharedAssets(CREDS)
    expect(result).toEqual({ ok: false, error: 'client_pixels: Invalid OAuth access token' })
  })

  it('returns a retryable-shaped error on a network failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    const result = await discoverSharedAssets(CREDS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('client_pixels')
  })
})
