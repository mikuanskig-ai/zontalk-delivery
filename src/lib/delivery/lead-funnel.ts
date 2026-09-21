import type { SupabaseClient } from '@supabase/supabase-js'

// Deterministic "AI moves the lead in the funnel" (Eder, 2026-09-21).
// Driven by the order lifecycle itself, not by the model remembering to
// call a tool — same principle as the order-placed auto-tag.
//
//   cart started (AI)        → open deal in the FIRST stage
//   order placed / paid      → that deal moves to the LAST stage, status
//                              'won', value = order total (a returning
//                              customer's next order gets its own deal)
//   order cancelled          → its deal becomes 'lost'
//   cart abandoned (sweep)   → the open deal becomes 'lost'
//
// The target pipeline is the account's first one; first/last stage are
// by position, so it works with whatever stages the account named.
// AI-managed deals are recognised by the marker in `deals.notes` — a
// deal a human created or edited by hand is never touched.

export const AUTO_DEAL_MARKER = 'auto:delivery'

interface FunnelTarget {
  pipelineId: string
  firstStageId: string
  lastStageId: string
  ownerUserId: string
}

async function resolveTarget(db: SupabaseClient, accountId: string): Promise<FunnelTarget | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pipeline) return null

  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, position')
    .eq('pipeline_id', (pipeline as { id: string }).id)
    .order('position', { ascending: true })
  const list = (stages ?? []) as { id: string }[]
  if (list.length === 0) return null

  const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
  const ownerUserId = (account as { owner_user_id: string | null } | null)?.owner_user_id
  if (!ownerUserId) return null

  return {
    pipelineId: (pipeline as { id: string }).id,
    firstStageId: list[0]!.id,
    lastStageId: list[list.length - 1]!.id,
    ownerUserId,
  }
}

async function findOpenAutoDeal(db: SupabaseClient, accountId: string, contactId: string): Promise<string | null> {
  const { data } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .like('notes', `${AUTO_DEAL_MARKER}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

function dealTitle(name: string | null | undefined): string {
  return `Pedido delivery — ${name?.trim() || 'cliente'}`
}

/** The AI put something in the cart: make sure there is an open deal in the first stage. */
export async function ensureLeadDealForCart(args: {
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string | null
  contactName: string | null
  currency: string
}): Promise<void> {
  try {
    const { db, accountId, contactId } = args
    if (await findOpenAutoDeal(db, accountId, contactId)) return
    const target = await resolveTarget(db, accountId)
    if (!target) return
    const { error } = await db.from('deals').insert({
      account_id: accountId,
      user_id: target.ownerUserId,
      pipeline_id: target.pipelineId,
      stage_id: target.firstStageId,
      contact_id: contactId,
      conversation_id: args.conversationId,
      title: dealTitle(args.contactName),
      value: 0,
      currency: args.currency,
      status: 'open',
      notes: AUTO_DEAL_MARKER,
    })
    if (error) throw error
  } catch (err) {
    console.error('[lead-funnel] ensureLeadDealForCart failed:', err instanceof Error ? err.message : err)
  }
}

/** An order was placed: move (or create) the deal to the last stage as won. Idempotent per order. */
export async function markLeadDealWon(args: {
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string | null
  contactName: string | null
  orderId: string
  total: number
  currency: string
}): Promise<void> {
  try {
    const { db, accountId, contactId, orderId } = args
    const orderNote = `${AUTO_DEAL_MARKER} order:${orderId}`

    const { data: already } = await db
      .from('deals')
      .select('id')
      .eq('account_id', accountId)
      .eq('notes', orderNote)
      .limit(1)
      .maybeSingle()
    if (already) return

    const target = await resolveTarget(db, accountId)
    if (!target) return

    const openDealId = await findOpenAutoDeal(db, accountId, contactId)
    if (openDealId) {
      const { error } = await db
        .from('deals')
        .update({
          stage_id: target.lastStageId,
          status: 'won',
          value: args.total,
          currency: args.currency,
          notes: orderNote,
          updated_at: new Date().toISOString(),
        })
        .eq('id', openDealId)
      if (error) throw error
      return
    }

    const { error } = await db.from('deals').insert({
      account_id: accountId,
      user_id: target.ownerUserId,
      pipeline_id: target.pipelineId,
      stage_id: target.lastStageId,
      contact_id: contactId,
      conversation_id: args.conversationId,
      title: dealTitle(args.contactName),
      value: args.total,
      currency: args.currency,
      status: 'won',
      notes: orderNote,
    })
    if (error) throw error
  } catch (err) {
    console.error('[lead-funnel] markLeadDealWon failed:', err instanceof Error ? err.message : err)
  }
}

/** The order was cancelled: its deal is no longer a win. */
export async function markLeadDealLostForOrder(db: SupabaseClient, accountId: string, orderId: string): Promise<void> {
  try {
    await db
      .from('deals')
      .update({ status: 'lost', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('notes', `${AUTO_DEAL_MARKER} order:${orderId}`)
  } catch (err) {
    console.error('[lead-funnel] markLeadDealLostForOrder failed:', err instanceof Error ? err.message : err)
  }
}

/** The cart was abandoned (sweep): the still-open AI deal is lost. */
export async function markOpenLeadDealLost(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  try {
    const id = await findOpenAutoDeal(db, accountId, contactId)
    if (!id) return
    await db.from('deals').update({ status: 'lost', updated_at: new Date().toISOString() }).eq('id', id)
  } catch (err) {
    console.error('[lead-funnel] markOpenLeadDealLost failed:', err instanceof Error ? err.message : err)
  }
}
