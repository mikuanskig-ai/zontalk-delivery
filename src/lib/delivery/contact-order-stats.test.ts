import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeOrderStats, ORDER_STAT_FIELD_NAMES, syncContactOrderStats } from './contact-order-stats'

describe('computeOrderStats', () => {
  it('sums totals, counts orders, averages, and finds the last order date in the business timezone', () => {
    const stats = computeOrderStats([
      { total: 45, created_at: '2026-09-10T15:00:00Z' },
      { total: '33.50', created_at: '2026-09-20T02:30:00Z' }, // 19/09 23:30 in São Paulo
      { total: 20, created_at: '2026-09-05T15:00:00Z' },
    ])
    expect(stats).toEqual({ count: 3, totalSpent: 98.5, avgTicket: 32.83, lastOrderDate: '2026-09-19' })
  })

  it('returns zeros and no date for a contact without orders', () => {
    expect(computeOrderStats([])).toEqual({ count: 0, totalSpent: 0, avgTicket: 0, lastOrderDate: null })
  })

  it('treats a null/garbage total as 0 instead of poisoning the sum', () => {
    const stats = computeOrderStats([
      { total: null, created_at: '2026-09-10T15:00:00Z' },
      { total: 10, created_at: '2026-09-11T15:00:00Z' },
    ])
    expect(stats.totalSpent).toBe(10)
    expect(stats.count).toBe(2)
  })
})

describe('syncContactOrderStats', () => {
  function fakeDb(opts: { orders: unknown[]; fields: { id: string; field_name: string }[] }) {
    const upserts: unknown[] = []
    const inserts: unknown[] = []
    const db = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          in: () => chain,
          order: () => chain,
          delete: () => chain,
          maybeSingle: () => Promise.resolve({ data: { owner_user_id: 'owner-1' }, error: null }),
          insert: (rows: unknown) => {
            inserts.push(rows)
            const created = (rows as { field_name: string }[]).map((r, i) => ({ id: `new-${i}`, field_name: r.field_name }))
            return { select: () => Promise.resolve({ data: created, error: null }) }
          },
          upsert: (rows: unknown) => {
            upserts.push(rows)
            return Promise.resolve({ error: null })
          },
          then: (resolve: (v: unknown) => void) => {
            if (table === 'delivery_orders') return resolve({ data: opts.orders, error: null })
            if (table === 'custom_fields') return resolve({ data: opts.fields, error: null })
            return resolve({ data: null, error: null })
          },
        }
        return chain
      },
    }
    return { db: db as unknown as SupabaseClient, upserts, inserts }
  }

  const allFields = Object.values(ORDER_STAT_FIELD_NAMES).map((name, i) => ({ id: `f${i}`, field_name: name }))

  it('writes the four purchase fields for the contact', async () => {
    const { db, upserts, inserts } = fakeDb({
      orders: [
        { total: 45, created_at: '2026-09-20T15:00:00Z' },
        { total: 55, created_at: '2026-09-21T15:00:00Z' },
      ],
      fields: allFields,
    })
    await syncContactOrderStats(db, 'acc-1', 'c-1')
    expect(inserts).toHaveLength(0)
    const rows = upserts[0] as { custom_field_id: string; value: string }[]
    const byField = Object.fromEntries(rows.map((r) => [r.custom_field_id, r.value]))
    expect(byField).toEqual({ f0: '100.00', f1: '2', f2: '2026-09-21', f3: '50.00' })
  })

  it('creates the custom fields on first use, owned by the account owner', async () => {
    const { db, inserts, upserts } = fakeDb({ orders: [{ total: 10, created_at: '2026-09-20T15:00:00Z' }], fields: [] })
    await syncContactOrderStats(db, 'acc-1', 'c-1')
    const created = inserts[0] as { field_name: string; user_id: string; account_id: string }[]
    expect(created.map((c) => c.field_name).sort()).toEqual(Object.values(ORDER_STAT_FIELD_NAMES).sort())
    expect(created.every((c) => c.user_id === 'owner-1' && c.account_id === 'acc-1')).toBe(true)
    expect(upserts).toHaveLength(1)
  })

  it('never throws, even when the orders read fails', async () => {
    const boom = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          neq: () => Promise.resolve({ data: null, error: new Error('db down') }),
        }
        return chain
      },
    } as unknown as SupabaseClient
    await expect(syncContactOrderStats(db, 'acc-1', 'c-1')).resolves.toBeUndefined()
    boom.mockRestore()
  })
})
