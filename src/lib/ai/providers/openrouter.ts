import { createOpenAiCompatibleProvider, type OpenAiNativeMessage } from './openai-compatible'

// OpenRouter — OpenAI-compatible gateway that proxies many providers
// under one key (`model` picks the underlying model, e.g.
// "anthropic/claude-sonnet-5"). See openai-compatible.ts.
const provider = createOpenAiCompatibleProvider({
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  label: 'OpenRouter',
  maxTokensParam: 'max_tokens',
})

export const generateOpenRouter = provider.generate
export const seedOpenRouterMessages = provider.seedMessages
export const appendOpenRouterToolResults = provider.appendToolResults
export const callOpenRouterTurn = provider.callTurn
export type { OpenAiNativeMessage as OpenRouterNativeMessage }

export interface OpenRouterBalance {
  limit: number | null
  limitRemaining: number | null
  usage: number
  isFreeTier: boolean
}

/**
 * Best-effort read of the account's OpenRouter credit balance (their
 * own BYO key, not ours) — used to warn "you're about to run out of
 * credits" before the provider starts hard-failing every AI call with
 * a 402. Never throws: a network hiccup or an unexpected response
 * shape should just hide the balance card, not break the usage page.
 */
export async function getOpenRouterBalance(
  apiKey: string,
  timeoutMs = 5000,
): Promise<OpenRouterBalance | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    if (!data || typeof data.usage !== 'number') return null
    return {
      limit: typeof data.limit === 'number' ? data.limit : null,
      limitRemaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
      usage: data.usage,
      isFreeTier: Boolean(data.is_free_tier),
    }
  } catch {
    return null
  }
}
