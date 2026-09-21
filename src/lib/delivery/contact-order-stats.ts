import type { SupabaseClient } from '@supabase/supabase-js'

// Per-contact purchase totals, kept as regular custom fields
// (custom_fields + contact_custom_values) so they show up in the
// contact panel, in filters, and in the contacts CSV export with zero
// extra plumbing. Purpose (Eder, 2026-09-21): the manager exports the
// contacts list as a Meta Ads audience — "Total gasto" doubles as the
// customer-lifetime-value column for value-based lookalikes.
//
// Always RECOMPUTED from delivery_orders (never incremented), so a
// duplicate call, a cancellation or a manual edit can never drift it.

export const ORDER_STAT_FIELD_NAMES = {
  totalSpent: 'Total gasto',
  ordersCount: 'Pedidos',
  lastOrderAt: 'Último pedido',
  avgTicket: 'Ticket médio',
} as const

const TIMEZONE = 'America/Sao_Paulo'

export interface OrderStats {
  count: number
  totalSpent: number
  avgTicket: number
  /** YYYY-MM-DD in the business timezone, null when no orders. */
  lastOrderDate: string | null
}

interface OrderRow {
  total: number | string | null
  created_at: string
}

/** Pure — exported for tests. Cancelled orders must be filtered by the caller. */
export function computeOrderStats(orders: OrderRow[]): OrderStats {
  if (orders.length === 0) return { count: 0, totalSpent: 0, avgTicket: 0, lastOrderDate: null }
  let sum = 0
  let last = 0
  for (const o of orders) {
    sum += Number(o.total) || 0
    last = Math.max(last, new Date(o.created_at).getTime())
  }
  const cents = Math.round(sum * 100)
  return {
    count: orders.length,
    totalSpent: cents / 100,
    avgTicket: Math.round(cents / orders.length) / 100,
    lastOrderDate: new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date(last)),
  }
}

async function ensureFieldIds(db: SupabaseClient, accountId: string): Promise<Record<string, string> | null> {
  const names = Object.values(ORDER_STAT_FIELD_NAMES)
  const { data: existing } = await db
    .from('custom_fields')
    .select('id, field_name, created_at')
    .eq('account_id', accountId)
    .in('field_name', names)
    .order('created_at', { ascending: true })

  const idByName: Record<string, string> = {}
  for (const f of (existing ?? []) as { id: string; field_name: string }[]) {
    if (!idByName[f.field_name]) idByName[f.field_name] = f.id // oldest wins if a race made twins
  }

  const missing = names.filter((n) => !idByName[n])
  if (missing.length > 0) {
    const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
    const ownerId = (account as { owner_user_id: string | null } | null)?.owner_user_id
    if (!ownerId) return null
    const { data: created } = await db
      .from('custom_fields')
      .insert(missing.map((field_name) => ({ account_id: accountId, user_id: ownerId, field_name, field_type: 'text' })))
      .select('id, field_name')
    for (const f of (created ?? []) as { id: string; field_name: string }[]) idByName[f.field_name] = f.id
  }
  return names.every((n) => idByName[n]) ? idByName : null
}

/**
 * Recomputes and stores the four purchase fields on one contact.
 * Best-effort: never throws (a CRM bookkeeping failure must never
 * affect taking or printing an order).
 */
export async function syncContactOrderStats(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  try {
    const { data: orders, error } = await db
      .from('delivery_orders')
      .select('total, created_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .neq('status', 'cancelled')
    if (error) throw error

    const stats = computeOrderStats((orders ?? []) as OrderRow[])
    const ids = await ensureFieldIds(db, accountId)
    if (!ids) return

    const n = ORDER_STAT_FIELD_NAMES
    const values: [string, string | null][] = [
      [n.totalSpent, stats.totalSpent.toFixed(2)],
      [n.ordersCount, String(stats.count)],
      [n.lastOrderAt, stats.lastOrderDate],
      [n.avgTicket, stats.avgTicket.toFixed(2)],
    ]

    const upserts = values
      .filter(([, v]) => v !== null)
      .map(([name, value]) => ({ contact_id: contactId, custom_field_id: ids[name]!, value: value as string }))
    const { error: upErr } = await db
      .from('contact_custom_values')
      .upsert(upserts, { onConflict: 'contact_id,custom_field_id' })
    if (upErr) throw upErr

    // Every order was cancelled/removed → the "last order" date no longer exists.
    if (stats.lastOrderDate === null) {
      await db.from('contact_custom_values').delete().eq('contact_id', contactId).eq('custom_field_id', ids[n.lastOrderAt]!)
    }
  } catch (err) {
    console.error('[contact-order-stats] sync failed:', err instanceof Error ? err.message : err)
  }
}
