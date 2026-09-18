import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendMetaConversion } from './send-conversion'

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  )
}

const BASE_INPUT = {
  pixelId: 'px-1',
  whatsappBusinessAccountId: 'waba-1',
  accessToken: 'tok-1',
  ctwaClid: 'clid-1',
  eventTime: 1700000000,
  value: 42.5,
  currency: 'BRL',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendMetaConversion', () => {
  it('posts a Purchase / business_messaging event with whatsapp_business_account_id + ctwa_clid', async () => {
    let capturedBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
      }),
    )

    const result = await sendMetaConversion(BASE_INPUT)

    expect(result).toEqual({ ok: true })
    const event = (capturedBody as { data: Record<string, unknown>[] }).data[0]
    expect(event).toMatchObject({
      event_name: 'Purchase',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: 'waba-1', ctwa_clid: 'clid-1' },
      custom_data: { currency: 'BRL', value: 42.5 },
    })
  })

  it('hits the pixel-scoped events endpoint', async () => {
    let capturedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
      }),
    )
    await sendMetaConversion(BASE_INPUT)
    expect(capturedUrl).toContain('/px-1/events')
  })

  it('omits custom_data when value is null', async () => {
    let capturedBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
      }),
    )
    await sendMetaConversion({ ...BASE_INPUT, value: null })
    const event = (capturedBody as { data: Record<string, unknown>[] }).data[0]
    expect(event.custom_data).toBeUndefined()
  })

  it('includes test_event_code only when provided', async () => {
    let capturedBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
      }),
    )
    await sendMetaConversion({ ...BASE_INPUT, testEventCode: 'TEST123' })
    expect((capturedBody as { test_event_code?: string }).test_event_code).toBe('TEST123')
  })

  it('treats a 4xx as non-retryable and surfaces error_user_msg over the generic message', async () => {
    mockFetchOnce(400, { error: { message: 'Invalid parameter', error_user_msg: 'Missing whatsapp_business_account_id', code: 100 } })
    const result = await sendMetaConversion(BASE_INPUT)
    expect(result).toEqual({ ok: false, retryable: false, error: 'Missing whatsapp_business_account_id — Invalid parameter (code=100)' })
  })

  it('treats a 5xx as retryable', async () => {
    mockFetchOnce(500, { error: { message: 'Internal error' } })
    const result = await sendMetaConversion(BASE_INPUT)
    expect(result.ok).toBe(false)
    expect((result as { retryable: boolean }).retryable).toBe(true)
  })

  it('treats a network/timeout failure as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await sendMetaConversion(BASE_INPUT)
    expect(result).toEqual({ ok: false, retryable: true, error: 'Error: network down' })
  })
})
