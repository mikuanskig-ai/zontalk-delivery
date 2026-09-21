import type { SupabaseClient } from '@supabase/supabase-js'
import { syncContactOrderStats } from './contact-order-stats'
import { markLeadDealWon, markLeadDealLostForOrder } from './lead-funnel'

interface OrderLike {
  id: string
  contact_id: string | null
  conversation_id: string | null
  customer_name: string | null
  total: number
  currency: string
}

/** New real order: register the purchase on the contact and win the funnel deal. Never throws. */
export async function syncOrderCreatedToCrm(db: SupabaseClient, accountId: string, order: OrderLike): Promise<void> {
  try {
    if (!order.contact_id) return
    const { data: contact } = await db.from('contacts').select('name').eq('id', order.contact_id).maybeSingle()
    const contactName = (contact as { name: string | null } | null)?.name ?? order.customer_name
    await markLeadDealWon({
      db,
      accountId,
      contactId: order.contact_id,
      conversationId: order.conversation_id,
      contactName,
      orderId: order.id,
      total: order.total,
      currency: order.currency,
    })
    await syncContactOrderStats(db, accountId, order.contact_id)
  } catch (err) {
    console.error('[order-crm-sync] created failed:', err instanceof Error ? err.message : err)
  }
}

/** Order cancelled: drop it from the contact's totals and un-win its deal. Never throws. */
export async function syncOrderCancelledToCrm(
  db: SupabaseClient,
  accountId: string,
  order: { id: string; contact_id: string | null },
): Promise<void> {
  try {
    await markLeadDealLostForOrder(db, accountId, order.id)
    if (order.contact_id) await syncContactOrderStats(db, accountId, order.contact_id)
  } catch (err) {
    console.error('[order-crm-sync] cancelled failed:', err instanceof Error ? err.message : err)
  }
}
