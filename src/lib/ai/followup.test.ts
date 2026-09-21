import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  engineSendText: vi.fn(),
  getAiBusinessHours: vi.fn(),
  isWithinBusinessHours: vi.fn(),
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/delivery/business-hours', () => ({
  getAiBusinessHours: h.getAiBusinessHours,
  isWithinBusinessHours: h.isWithinBusinessHours,
}))
vi.mock('@/lib/delivery/lead-funnel', () => ({ markOpenLeadDealLost: vi.fn(async () => {}) }))

import { runFollowupSweep } from './followup'

const NOW = new Date('2026-09-21T15:00:00Z').getTime()
const MIN = 60_000
const iso = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString()

interface Call {
  table: string
  op: 'select' | 'update'
  payload?: Record<string, unknown>
  filters: [string, unknown][]
}

/** Tables answer from `data`; updates resolve to one affected row unless `claimFails`. */
function fakeDb(data: {
  ai_configs?: unknown[]
  due?: unknown[]
  convs?: unknown[]
  lastSender?: string
  claimFails?: boolean
}) {
  const calls: Call[] = []
  const db = {
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [] }
      calls.push(call)
      const resolve = () => {
        if (call.op === 'update') return { data: data.claimFails ? [] : [{ id: 'x' }], error: null }
        if (table === 'ai_configs') return { data: data.ai_configs ?? [], error: null }
        if (table === 'conversations') {
          const isDue = call.filters.some(([c]) => c === 'ai_close_at')
          return { data: isDue ? (data.due ?? []) : (data.convs ?? []), error: null }
        }
        if (table === 'messages') return { data: { sender_type: data.lastSender ?? 'bot' }, error: null }
        if (table === 'contacts') return { data: { name: 'Maria da Silva' }, error: null }
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => ((call.op = 'update'), (call.payload = p), chain),
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), chain),
        not: (c: string) => (call.filters.push([c, 'not-null']), chain),
        lte: () => chain,
        is: () => chain,
        neq: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(resolve()),
        then: (res: (v: unknown) => void) => res(resolve()),
      }
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const cfg = (over: Record<string, unknown> = {}) => ({
  account_id: 'acc-1',
  followup_enabled: true,
  followup_delay_minutes: 20,
  followup_max: 1,
  followup_messages: null,
  followup_close_minutes: 120,
  auto_close_after_order_minutes: null,
  ...over,
})

const conv = (over: Record<string, unknown> = {}) => ({
  id: 'conv-1',
  user_id: 'user-1',
  contact_id: 'contact-1',
  last_message_at: iso(30),
  ai_cart: [{ product_name: 'Marmita M', quantity: 2 }],
  ai_followup_count: 0,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wa-1' })
  h.getAiBusinessHours.mockResolvedValue({ enabled: false, hours: {}, timezone: 'America/Sao_Paulo' })
  h.isWithinBusinessHours.mockReturnValue(true)
})

describe('runFollowupSweep — nudges', () => {
  it('sends a personalised nudge to a customer who left items in the cart, and records it', async () => {
    const { db, calls } = fakeDb({ ai_configs: [cfg()], convs: [conv()] })
    const r = await runFollowupSweep(db, NOW)

    expect(r).toEqual({ sent: 1, closedNoReply: 0, autoClosed: 0 })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    const sent = h.engineSendText.mock.calls[0]![0]
    expect(sent).toMatchObject({ accountId: 'acc-1', conversationId: 'conv-1', contactId: 'contact-1', userId: 'user-1', aiGenerated: true })
    expect(sent.text).toContain('Maria')
    expect(sent.text).toContain('2x Marmita M')
    const claim = calls.find((c) => c.op === 'update')!
    expect(claim.payload).toMatchObject({ ai_followup_count: 1 })
    expect(claim.filters).toContainEqual(['ai_followup_count', 0]) // optimistic claim
  })

  it('does not send when another sweep already claimed this nudge', async () => {
    const { db } = fakeDb({ ai_configs: [cfg()], convs: [conv()], claimFails: true })
    const r = await runFollowupSweep(db, NOW)
    expect(r.sent).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not nudge when the customer is the one waiting for a reply', async () => {
    const { db } = fakeDb({ ai_configs: [cfg()], convs: [conv()], lastSender: 'customer' })
    expect((await runFollowupSweep(db, NOW)).sent).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not nudge outside the AI service hours', async () => {
    h.getAiBusinessHours.mockResolvedValue({ enabled: true, hours: {}, timezone: 'America/Sao_Paulo' })
    h.isWithinBusinessHours.mockReturnValue(false)
    const { db } = fakeDb({ ai_configs: [cfg()], convs: [conv()] })
    expect((await runFollowupSweep(db, NOW)).sent).toBe(0)
  })

  it('does nothing for accounts that turned follow-up off (and have no auto-close)', async () => {
    const { db } = fakeDb({ ai_configs: [cfg({ followup_enabled: false })], convs: [conv()] })
    expect(await runFollowupSweep(db, NOW)).toEqual({ sent: 0, closedNoReply: 0, autoClosed: 0 })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('a send failure is logged and never aborts the sweep', async () => {
    h.engineSendText.mockRejectedValue(new Error('whatsapp down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({ ai_configs: [cfg()], convs: [conv(), conv({ id: 'conv-2' })] })
    const r = await runFollowupSweep(db, NOW)
    expect(r.sent).toBe(0)
    expect(h.engineSendText).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('runFollowupSweep — closing', () => {
  it('closes a ticket whose nudges all went unanswered past the close window', async () => {
    const { db, calls } = fakeDb({
      ai_configs: [cfg()],
      convs: [conv({ ai_followup_count: 1, last_message_at: iso(130) })],
    })
    const r = await runFollowupSweep(db, NOW)
    expect(r.closedNoReply).toBe(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    const close = calls.find((c) => c.op === 'update')!
    expect(close.payload).toMatchObject({ status: 'closed', close_reason: 'followup_no_reply', ai_cart: [] })
  })

  it('auto-closes a due post-order ticket that is still pending with an empty cart', async () => {
    const { db, calls } = fakeDb({
      ai_configs: [cfg({ followup_enabled: false, auto_close_after_order_minutes: 20 })],
      due: [{ id: 'conv-9', contact_id: 'contact-9', status: 'pending', ai_cart: [] }],
    })
    const r = await runFollowupSweep(db, NOW)
    expect(r.autoClosed).toBe(1)
    expect(calls.find((c) => c.op === 'update')!.payload).toMatchObject({ status: 'closed', close_reason: 'auto_after_order' })
  })

  it('does NOT auto-close a ticket a human took over, or one where the customer is ordering again — just clears the timer', async () => {
    const { db, calls } = fakeDb({
      ai_configs: [cfg({ followup_enabled: false, auto_close_after_order_minutes: 20 })],
      due: [
        { id: 'open-1', contact_id: 'c1', status: 'open', ai_cart: [] },
        { id: 'cart-1', contact_id: 'c2', status: 'pending', ai_cart: [{ product_name: 'X' }] },
      ],
    })
    const r = await runFollowupSweep(db, NOW)
    expect(r.autoClosed).toBe(0)
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates).toHaveLength(2)
    expect(updates.every((u) => u.payload && 'ai_close_at' in u.payload && u.payload.ai_close_at === null && !('status' in u.payload))).toBe(true)
  })
})
