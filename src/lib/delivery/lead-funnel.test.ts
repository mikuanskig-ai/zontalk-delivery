import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AUTO_DEAL_MARKER,
  ensureLeadDealForCart,
  markLeadDealLostForOrder,
  markLeadDealWon,
  markOpenLeadDealLost,
} from './lead-funnel'

interface Op {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: Record<string, unknown>
  filters: [string, unknown][]
}

/** Call-order fake: every awaited/terminal read for a table consumes the next queued result. */
function fakeDb(queues: Record<string, unknown[]>) {
  const ops: Op[] = []
  const db = {
    from: (table: string) => {
      const op: Op = { table, op: 'select', filters: [] }
      ops.push(op)
      const next = () => {
        const q = queues[`${table}:${op.op}`] ?? queues[table] ?? []
        return { data: q.length > 0 ? q.shift() : null, error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (p: Record<string, unknown>) => ((op.op = 'insert'), (op.payload = p), chain),
        update: (p: Record<string, unknown>) => ((op.op = 'update'), (op.payload = p), chain),
        eq: (c: string, v: unknown) => (op.filters.push([c, v]), chain),
        neq: () => chain,
        like: (c: string, v: unknown) => (op.filters.push([c, v]), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(next()),
        then: (resolve: (v: unknown) => void) => resolve(next()),
      }
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, ops }
}

// A factory (fresh arrays per test) — the fake DB consumes queue entries.
const target = () => ({
  pipelines: [{ id: 'pipe-1' }],
  pipeline_stages: [[{ id: 'stage-first', position: 0 }, { id: 'stage-mid', position: 1 }, { id: 'stage-won', position: 4 }]],
  accounts: [{ owner_user_id: 'owner-1' }],
})

describe('markLeadDealWon', () => {
  const args = {
    accountId: 'acc-1',
    contactId: 'c-1',
    conversationId: 'conv-1',
    contactName: 'Maria',
    orderId: 'ord-1',
    total: 45,
    currency: 'BRL',
  }

  it('moves the existing open AI deal to the LAST stage as won, with the order total', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [null, { id: 'deal-9' }], ...target() })
    await markLeadDealWon({ db, ...args })
    const upd = ops.find((o) => o.table === 'deals' && o.op === 'update')!
    expect(upd.payload).toMatchObject({
      stage_id: 'stage-won',
      status: 'won',
      value: 45,
      notes: `${AUTO_DEAL_MARKER} order:ord-1`,
    })
    expect(upd.filters).toContainEqual(['id', 'deal-9'])
  })

  it('creates a won deal in the last stage when the lead has no open one', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [null, null], ...target() })
    await markLeadDealWon({ db, ...args })
    const ins = ops.find((o) => o.op === 'insert')!
    expect(ins.payload).toMatchObject({
      stage_id: 'stage-won',
      status: 'won',
      value: 45,
      contact_id: 'c-1',
      user_id: 'owner-1',
      title: 'Pedido delivery — Maria',
    })
  })

  it('is idempotent per order: does nothing when this order already has its deal', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [{ id: 'existing' }], ...target() })
    await markLeadDealWon({ db, ...args })
    expect(ops.some((o) => o.op === 'insert' || o.op === 'update')).toBe(false)
  })

  it('does nothing when the account has no pipeline', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [null], pipelines: [null] })
    await markLeadDealWon({ db, ...args })
    expect(ops.some((o) => o.op === 'insert' || o.op === 'update')).toBe(false)
  })
})

describe('ensureLeadDealForCart', () => {
  const args = { accountId: 'acc-1', contactId: 'c-1', conversationId: 'conv-1', contactName: null, currency: 'BRL' }

  it('opens a deal in the FIRST stage, value 0, marked as AI-managed', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [null], ...target() })
    await ensureLeadDealForCart({ db, ...args })
    const ins = ops.find((o) => o.op === 'insert')!
    expect(ins.payload).toMatchObject({
      stage_id: 'stage-first',
      status: 'open',
      value: 0,
      notes: AUTO_DEAL_MARKER,
      title: 'Pedido delivery — cliente',
    })
  })

  it('does not open a second deal when one is already open', async () => {
    const { db, ops } = fakeDb({ 'deals:select': [{ id: 'deal-1' }], ...target() })
    await ensureLeadDealForCart({ db, ...args })
    expect(ops.some((o) => o.op === 'insert')).toBe(false)
  })
})

describe('losing deals', () => {
  it('a cancelled order un-wins exactly its own deal', async () => {
    const { db, ops } = fakeDb({})
    await markLeadDealLostForOrder(db, 'acc-1', 'ord-1')
    const upd = ops.find((o) => o.op === 'update')!
    expect(upd.payload).toMatchObject({ status: 'lost' })
    expect(upd.filters).toContainEqual(['notes', `${AUTO_DEAL_MARKER} order:ord-1`])
  })

  it('an abandoned cart loses the open AI deal, and does nothing when there is none', async () => {
    const withDeal = fakeDb({ 'deals:select': [{ id: 'deal-1' }] })
    await markOpenLeadDealLost(withDeal.db, 'acc-1', 'c-1')
    expect(withDeal.ops.find((o) => o.op === 'update')?.payload).toMatchObject({ status: 'lost' })

    const without = fakeDb({ 'deals:select': [null] })
    await markOpenLeadDealLost(without.db, 'acc-1', 'c-1')
    expect(without.ops.some((o) => o.op === 'update')).toBe(false)
  })
})
