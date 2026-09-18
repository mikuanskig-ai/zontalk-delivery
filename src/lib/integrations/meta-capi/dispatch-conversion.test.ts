import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendMetaConversion: vi.fn(),
  getMetaCapiPlatformCredentials: vi.fn(),
}))

vi.mock('./send-conversion', () => ({ sendMetaConversion: h.sendMetaConversion }))
vi.mock('./discover-assets', () => ({ getMetaCapiPlatformCredentials: h.getMetaCapiPlatformCredentials }))

import { dispatchMetaCapiConversion } from './dispatch-conversion'

function fakeDb(opts: {
  config?: Record<string, unknown> | null
  contact?: Record<string, unknown> | null
}) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: table === 'meta_capi_configs' ? (opts.config ?? null) : (opts.contact ?? null),
              error: null,
            }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const ACTIVE_CONFIG = { pixel_id: 'px-1', whatsapp_business_account_id: 'waba-1', is_active: true, test_event_code: null }
const CONTACT_WITH_CLID = { ad_attribution: { ctwa_clid: 'clid-1' } }
const CREDS = { systemUserToken: 'tok-1', businessId: 'biz-1' }

const ARGS = {
  db: null as unknown,
  accountId: 'acct-1',
  contactId: 'contact-1',
  orderId: 'order-1',
  total: 42.5,
  currency: 'BRL',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getMetaCapiPlatformCredentials.mockReturnValue(CREDS)
  h.sendMetaConversion.mockResolvedValue({ ok: true })
})

describe('dispatchMetaCapiConversion', () => {
  it('sends the conversion when everything lines up', async () => {
    const db = fakeDb({ config: ACTIVE_CONFIG, contact: CONTACT_WITH_CLID })
    await dispatchMetaCapiConversion({ ...ARGS, db })

    expect(h.sendMetaConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        pixelId: 'px-1',
        whatsappBusinessAccountId: 'waba-1',
        accessToken: 'tok-1',
        ctwaClid: 'clid-1',
        value: 42.5,
        currency: 'BRL',
      }),
    )
  })

  it('skips silently when there is no contact id', async () => {
    const db = fakeDb({ config: ACTIVE_CONFIG, contact: CONTACT_WITH_CLID })
    await dispatchMetaCapiConversion({ ...ARGS, db, contactId: null })
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('skips silently when the account has no meta_capi_configs row at all', async () => {
    const db = fakeDb({ config: null, contact: CONTACT_WITH_CLID })
    await dispatchMetaCapiConversion({ ...ARGS, db })
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('skips silently when is_active is false', async () => {
    const db = fakeDb({ config: { ...ACTIVE_CONFIG, is_active: false }, contact: CONTACT_WITH_CLID })
    await dispatchMetaCapiConversion({ ...ARGS, db })
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('skips silently when pixel_id or whatsapp_business_account_id is missing (link incomplete)', async () => {
    const db = fakeDb({ config: { ...ACTIVE_CONFIG, whatsapp_business_account_id: null }, contact: CONTACT_WITH_CLID })
    await dispatchMetaCapiConversion({ ...ARGS, db })
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('skips silently — the normal case — when this contact has no ad_attribution (didn\'t come from an ad click)', async () => {
    const db = fakeDb({ config: ACTIVE_CONFIG, contact: { ad_attribution: null } })
    await dispatchMetaCapiConversion({ ...ARGS, db })
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('logs and skips (never throws) when the platform-level credentials are unset', async () => {
    h.getMetaCapiPlatformCredentials.mockReturnValue(null)
    const db = fakeDb({ config: ACTIVE_CONFIG, contact: CONTACT_WITH_CLID })
    await expect(dispatchMetaCapiConversion({ ...ARGS, db })).resolves.toBeUndefined()
    expect(h.sendMetaConversion).not.toHaveBeenCalled()
  })

  it('never throws when the db query itself throws — must never break order creation', async () => {
    const db = {
      from: () => {
        throw new Error('db exploded')
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await expect(dispatchMetaCapiConversion({ ...ARGS, db })).resolves.toBeUndefined()
  })

  it('logs but does not throw when Meta rejects the event', async () => {
    h.sendMetaConversion.mockResolvedValue({ ok: false, retryable: false, error: 'bad token' })
    const db = fakeDb({ config: ACTIVE_CONFIG, contact: CONTACT_WITH_CLID })
    await expect(dispatchMetaCapiConversion({ ...ARGS, db })).resolves.toBeUndefined()
  })
})
