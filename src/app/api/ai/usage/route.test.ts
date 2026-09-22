import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  getOpenRouterBalance: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/ai/providers/openrouter', () => ({ getOpenRouterBalance: h.getOpenRouterBalance }))

import { GET } from './route'

function fakeSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }
}

const call = () => GET(new Request('http://localhost/api/ai/usage'))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ supabase: fakeSupabase(), accountId: 'acc-1' })
})

describe('GET /api/ai/usage — provider_balance', () => {
  it('includes the OpenRouter credit balance when the account is on OpenRouter', async () => {
    h.loadAiConfig.mockResolvedValue({ provider: 'openrouter', apiKey: 'sk-or-test' })
    h.getOpenRouterBalance.mockResolvedValue({
      limit: 20,
      limitRemaining: 2.5,
      usage: 17.5,
      isFreeTier: false,
    })

    const body = await (await call()).json()

    expect(h.getOpenRouterBalance).toHaveBeenCalledWith('sk-or-test')
    expect(body.provider_balance).toEqual({
      provider: 'openrouter',
      limit: 20,
      limit_remaining: 2.5,
      usage: 17.5,
      is_free_tier: false,
    })
  })

  it('is null for a non-OpenRouter provider — never calls out to OpenRouter', async () => {
    h.loadAiConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-test' })

    const body = await (await call()).json()

    expect(h.getOpenRouterBalance).not.toHaveBeenCalled()
    expect(body.provider_balance).toBeNull()
  })

  it('is null (not a route failure) when there is no AI config at all', async () => {
    h.loadAiConfig.mockResolvedValue(null)

    const res = await call()

    expect(res.status).toBe(200)
    expect((await res.json()).provider_balance).toBeNull()
  })

  it('is null when the OpenRouter lookup fails — usage totals still return', async () => {
    h.loadAiConfig.mockResolvedValue({ provider: 'openrouter', apiKey: 'sk-or-test' })
    h.getOpenRouterBalance.mockRejectedValue(new Error('network down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await call()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.provider_balance).toBeNull()
    expect(body.totals).toBeDefined()
    spy.mockRestore()
  })
})
