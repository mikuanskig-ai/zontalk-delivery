import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_FOLLOWUP_MESSAGES,
  closeConversationByAi,
  decideFollowup,
  parseFollowupSettings,
  renderFollowupText,
  resetFollowupOnInbound,
  scheduleAutoCloseAfterOrder,
  type FollowupSettings,
} from './followup-state'

const MIN = 60_000
const NOW = new Date('2026-09-21T15:00:00Z').getTime()

const settings = (over: Partial<FollowupSettings> = {}): FollowupSettings => ({
  enabled: true,
  delayMinutes: 20,
  max: 2,
  messages: DEFAULT_FOLLOWUP_MESSAGES,
  closeMinutes: 120,
  autoCloseAfterOrderMinutes: 20,
  ...over,
})

describe('parseFollowupSettings', () => {
  it('is off with sane defaults for an empty row', () => {
    const s = parseFollowupSettings(null)
    expect(s).toMatchObject({ enabled: false, delayMinutes: 20, max: 1, closeMinutes: 120, autoCloseAfterOrderMinutes: null })
    expect(s.messages).toEqual(DEFAULT_FOLLOWUP_MESSAGES)
  })

  it('a blank entry means "default for THIS nudge" (positions are kept)', () => {
    const s = parseFollowupSettings({
      followup_enabled: true,
      followup_delay_minutes: 30,
      followup_max: 2,
      followup_messages: ['', 'Meu segundo texto'],
      followup_close_minutes: 0,
      auto_close_after_order_minutes: 15,
    })
    expect(s.messages[0]).toBe(DEFAULT_FOLLOWUP_MESSAGES[0])
    expect(s.messages[1]).toBe('Meu segundo texto')
    expect(s).toMatchObject({ enabled: true, delayMinutes: 30, closeMinutes: 0, autoCloseAfterOrderMinutes: 15 })
  })
})

describe('renderFollowupText', () => {
  const cart = [{ product_name: 'Marmita M', quantity: 2 }, { product_name: 'Coca 2L', quantity: 1 }]

  it('fills the first name and the items', () => {
    expect(renderFollowupText(DEFAULT_FOLLOWUP_MESSAGES[0]!, { name: 'Maria da Silva', cart })).toBe(
      'Oi Maria! Vi que você começou seu pedido (2x Marmita M, Coca 2L), mas ainda não finalizamos. Quer que eu continue de onde paramos? 😊',
    )
  })

  it('tidies the greeting when the name is unknown', () => {
    expect(renderFollowupText('Oi{nome}! Tudo bem?', { name: null, cart })).toBe('Oi! Tudo bem?')
  })

  it('drops the empty parentheses when there are no items', () => {
    expect(renderFollowupText('Seu pedido ({itens}) espera.', { name: 'Ana', cart: [] })).toBe('Seu pedido espera.')
  })
})

describe('decideFollowup', () => {
  const base = { nowMs: NOW, lastMessageFromCustomer: false, followupCount: 0, settings: settings(), withinHours: true }

  it('sends nudge #1 once the customer has been silent long enough', () => {
    expect(decideFollowup({ ...base, lastMessageAtMs: NOW - 25 * MIN })).toEqual({ action: 'send', index: 0 })
  })

  it('waits while the silence is shorter than the delay', () => {
    expect(decideFollowup({ ...base, lastMessageAtMs: NOW - 10 * MIN })).toEqual({ action: 'skip' })
  })

  it('never nudges when the last message is the CUSTOMER\'s (we owe them a reply, not a reminder)', () => {
    expect(decideFollowup({ ...base, lastMessageAtMs: NOW - 60 * MIN, lastMessageFromCustomer: true })).toEqual({ action: 'skip' })
  })

  it('sends the next nudge (index 1) after the previous one went unanswered', () => {
    expect(decideFollowup({ ...base, followupCount: 1, lastMessageAtMs: NOW - 21 * MIN })).toEqual({ action: 'send', index: 1 })
  })

  it('does not send outside the AI service hours', () => {
    expect(decideFollowup({ ...base, lastMessageAtMs: NOW - 25 * MIN, withinHours: false })).toEqual({ action: 'skip' })
  })

  it('leaves very old carts to the abandoned-cart sweep instead of nudging hours later', () => {
    expect(decideFollowup({ ...base, lastMessageAtMs: NOW - 13 * 60 * MIN })).toEqual({ action: 'skip' })
  })

  it('closes after all nudges were sent and the customer stayed silent long enough', () => {
    expect(decideFollowup({ ...base, followupCount: 2, lastMessageAtMs: NOW - 121 * MIN })).toEqual({ action: 'close' })
  })

  it('waits before closing, and never closes when closeMinutes is 0', () => {
    expect(decideFollowup({ ...base, followupCount: 2, lastMessageAtMs: NOW - 60 * MIN })).toEqual({ action: 'skip' })
    expect(
      decideFollowup({ ...base, followupCount: 2, lastMessageAtMs: NOW - 999 * MIN, settings: settings({ closeMinutes: 0 }) }),
    ).toEqual({ action: 'skip' })
  })

  it('closing does not depend on service hours', () => {
    expect(decideFollowup({ ...base, followupCount: 2, lastMessageAtMs: NOW - 200 * MIN, withinHours: false })).toEqual({ action: 'close' })
  })
})

/** Records writes; every read resolves with the queued value for its table. */
function fakeDb(reads: Record<string, unknown> = {}) {
  const updates: { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }[] = []
  const db = {
    from: (table: string) => {
      const rec = { table, payload: {} as Record<string, unknown>, filters: [] as [string, unknown][] }
      let isUpdate = false
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => ((isUpdate = true), (rec.payload = p), updates.push(rec), chain),
        eq: (c: string, v: unknown) => (rec.filters.push([c, v]), chain),
        neq: () => chain,
        like: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: reads[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: isUpdate ? [{ id: 'conv-1' }] : (reads[table] ?? null), error: null }),
      }
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, updates }
}

describe('closeConversationByAi', () => {
  it('closes the ticket with the reason, clears the cart and the pending auto-close', async () => {
    const { db, updates } = fakeDb()
    const ok = await closeConversationByAi(db, { accountId: 'a1', conversationId: 'conv-1', contactId: 'c1', reason: 'followup_no_reply' })
    expect(ok).toBe(true)
    const conv = updates.find((u) => u.table === 'conversations')!
    expect(conv.payload).toMatchObject({ status: 'closed', close_reason: 'followup_no_reply', ai_cart: [], ai_close_at: null, closed_by: null })
    expect(conv.filters).toContainEqual(['account_id', 'a1'])
  })
})

describe('scheduleAutoCloseAfterOrder', () => {
  it('schedules the close N minutes ahead when the account enabled it', async () => {
    const { db, updates } = fakeDb({
      ai_configs: { is_active: true, auto_reply_enabled: true, auto_close_after_order_minutes: 20 },
    })
    const before = Date.now()
    await scheduleAutoCloseAfterOrder(db, 'a1', 'conv-1')
    const at = new Date(updates[0]!.payload.ai_close_at as string).getTime()
    expect(at - before).toBeGreaterThanOrEqual(20 * MIN - 50)
    expect(at - before).toBeLessThan(20 * MIN + 5_000)
  })

  it('does nothing when auto-close is off, or the AI itself is off', async () => {
    const off = fakeDb({ ai_configs: { is_active: true, auto_reply_enabled: true, auto_close_after_order_minutes: null } })
    await scheduleAutoCloseAfterOrder(off.db, 'a1', 'conv-1')
    expect(off.updates).toHaveLength(0)

    const aiOff = fakeDb({ ai_configs: { is_active: false, auto_reply_enabled: true, auto_close_after_order_minutes: 20 } })
    await scheduleAutoCloseAfterOrder(aiOff.db, 'a1', 'conv-1')
    expect(aiOff.updates).toHaveLength(0)
  })
})

describe('resetFollowupOnInbound', () => {
  it('resets the nudge counter and pushes a pending auto-close back', async () => {
    const { db, updates } = fakeDb({ ai_configs: { auto_close_after_order_minutes: 30 } })
    await resetFollowupOnInbound(db, 'a1', { id: 'conv-1', ai_followup_count: 2, ai_close_at: '2026-09-21T15:00:00Z' })
    expect(updates[0]!.payload).toMatchObject({ ai_followup_count: 0, ai_followup_at: null })
    expect(new Date(updates[0]!.payload.ai_close_at as string).getTime()).toBeGreaterThan(Date.now() + 29 * MIN)
  })

  it('is a no-op (no write) for an ordinary conversation', async () => {
    const { db, updates } = fakeDb()
    await resetFollowupOnInbound(db, 'a1', { id: 'conv-1', ai_followup_count: 0, ai_close_at: null })
    expect(updates).toHaveLength(0)
  })
})
