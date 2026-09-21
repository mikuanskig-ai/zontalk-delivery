import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaymentLink, checkPayment } from './infinitepay-api'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createPaymentLink', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts order_nsu + items (price in cents) and returns the checkout url', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ url: 'https://checkout.infinitepay.com.br/sua_tag?lenc=abc' }),
    )

    const result = await createPaymentLink({
      handle: 'zontalk',
      orderNsu: 'invoice-1',
      amountCents: 9900,
      description: 'Plano Pro — mensalidade',
      redirectUrl: 'https://app.example/settings?tab=billing',
      webhookUrl: 'https://app.example/api/billing/webhook',
    })

    expect(result).toEqual({ url: 'https://checkout.infinitepay.com.br/sua_tag?lenc=abc' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.checkout.infinitepay.io/links')
    const body = JSON.parse(init.body)
    expect(body.handle).toBe('zontalk')
    expect(body.order_nsu).toBe('invoice-1')
    expect(body.items[0]).toEqual({ quantity: 1, price: 9900, description: 'Plano Pro — mensalidade' })
  })

  it('throws with the API message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, { message: 'invalid handle' }))

    await expect(
      createPaymentLink({
        handle: 'bad',
        orderNsu: 'invoice-1',
        amountCents: 100,
        description: 'x',
        redirectUrl: 'https://app.example',
        webhookUrl: 'https://app.example/webhook',
      }),
    ).rejects.toThrow('invalid handle')
  })
})

describe('checkPayment', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('INFINITEPAY_HANDLE', 'minha-loja')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('sends the platform handle with the order_nsu (InfinitePay 404s without it — 2026-09-21)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ success: false }))
    await checkPayment({ orderNsu: 'invoice-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/payment_check')
    expect(JSON.parse(init.body)).toEqual({ handle: 'minha-loja', order_nsu: 'invoice-1' })
  })

  it('treats a {"success":false} gateway answer as unpaid, not as an error', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ success: false }))
    expect(await checkPayment({ orderNsu: 'invoice-1' })).toEqual({ paid: false, paidAmountCents: 0 })
  })

  it('reports a paid link with its amount', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ paid: true, paid_amount: 9900 }))
    const result = await checkPayment({ orderNsu: 'invoice-1' })
    expect(result).toEqual({ paid: true, paidAmountCents: 9900 })
  })

  it('reports an unpaid link', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ paid: false }))
    const result = await checkPayment({ orderNsu: 'invoice-1' })
    expect(result).toEqual({ paid: false, paidAmountCents: 0 })
  })

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, { message: 'order not found' }))
    await expect(checkPayment({ orderNsu: 'missing' })).rejects.toThrow('order not found')
  })
})
