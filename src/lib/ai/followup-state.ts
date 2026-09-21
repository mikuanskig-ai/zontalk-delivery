import type { SupabaseClient } from '@supabase/supabase-js'
import { markOpenLeadDealLost } from '@/lib/delivery/lead-funnel'

// AI follow-up + automatic close (Eder, 2026-09-21).
//
//  - Started an order (cart has items) and went silent → nudge after
//    N min, up to `max` times; still silent → close the ticket.
//  - Order placed → N min after the customer's last message, send the
//    ticket to Fechados.
//  - Customer answers "já pedi / não quero mais" → the AI itself closes
//    (close_conversation tool, delivery.ts).
// Opt-in per account (migration 084). Any customer message re-opens the
// ticket and hands it back to the AI (inbound-message.ts reopenPatch).

export const DEFAULT_FOLLOWUP_MESSAGES = [
  'Oi{nome}! Vi que você começou seu pedido ({itens}), mas ainda não finalizamos. Quer que eu continue de onde paramos? 😊',
  'Oi{nome}, ainda por aqui! Se quiser retomar o seu pedido é só me responder. Se não for pedir agora, sem problema, me avisa que eu encerro por aqui. 🙂',
  'Oi{nome}! Só passando pra saber se ainda quer finalizar o seu pedido. Qualquer coisa é só chamar! 🙂',
]

/** A cart older than this is left to the 6h abandoned-cart sweep instead. */
const MAX_FOLLOWUP_AGE_MS = 12 * 60 * 60 * 1000

export interface FollowupSettings {
  enabled: boolean
  delayMinutes: number
  max: number
  /** One text per follow-up (index = which nudge); missing ones reuse the last. */
  messages: string[]
  /** Minutes after the LAST unanswered nudge before the ticket is closed; 0 = never. */
  closeMinutes: number
  /** Minutes after an order (and the customer's last message) before auto-close; null = off. */
  autoCloseAfterOrderMinutes: number | null
}

export interface FollowupConfigRow {
  followup_enabled: boolean | null
  followup_delay_minutes: number | null
  followup_max: number | null
  followup_messages: unknown
  followup_close_minutes: number | null
  auto_close_after_order_minutes: number | null
}

/** Pure — turns a DB row into resolved settings (defaults filled). */
export function parseFollowupSettings(row: FollowupConfigRow | null): FollowupSettings {
  // Position-aware: a blank entry means "use the default for THIS nudge",
  // so the admin can customise only the second message, say.
  const custom = Array.isArray(row?.followup_messages) ? (row!.followup_messages as unknown[]) : []
  const messages = DEFAULT_FOLLOWUP_MESSAGES.map((fallback, i) => {
    const typed = custom[i]
    return typeof typed === 'string' && typed.trim() ? typed.trim() : fallback
  })
  return {
    enabled: row?.followup_enabled === true,
    delayMinutes: row?.followup_delay_minutes ?? 20,
    max: row?.followup_max ?? 1,
    messages,
    closeMinutes: row?.followup_close_minutes ?? 120,
    autoCloseAfterOrderMinutes: row?.auto_close_after_order_minutes ?? null,
  }
}

export interface CartLine {
  product_name?: string
  quantity?: number
}

/** Pure — fills {nome} / {itens} and tidies the punctuation when a var is empty. */
export function renderFollowupText(template: string, vars: { name: string | null; cart: CartLine[] }): string {
  const first = vars.name?.trim().split(/\s+/)[0] ?? ''
  const items = vars.cart
    .filter((l) => l.product_name)
    .map((l) => `${l.quantity && l.quantity > 1 ? `${l.quantity}x ` : ''}${l.product_name}`)
    .join(', ')
  return template
    .replace(/\{nome\}/gi, first ? ` ${first}` : '')
    .replace(/\s*\(\s*\{itens\}\s*\)/gi, items ? ` (${items})` : '')
    .replace(/\{itens\}/gi, items)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([!,.?])/g, '$1')
    .trim()
}

export type FollowupDecision = { action: 'send'; index: number } | { action: 'close' } | { action: 'skip' }

/** Pure — what the sweep should do with one in-progress-order ticket. */
export function decideFollowup(input: {
  nowMs: number
  lastMessageAtMs: number
  lastMessageFromCustomer: boolean
  followupCount: number
  settings: FollowupSettings
  withinHours: boolean
}): FollowupDecision {
  const { nowMs, lastMessageAtMs, lastMessageFromCustomer, followupCount, settings, withinHours } = input
  // The customer is waiting on US (or the AI is mid-reply) — not a follow-up case.
  if (lastMessageFromCustomer) return { action: 'skip' }
  const silentMs = nowMs - lastMessageAtMs

  if (followupCount >= settings.max) {
    const closeMs = settings.closeMinutes * 60_000
    return settings.closeMinutes > 0 && silentMs >= closeMs ? { action: 'close' } : { action: 'skip' }
  }
  if (!withinHours) return { action: 'skip' }
  if (silentMs < settings.delayMinutes * 60_000 || silentMs > MAX_FOLLOWUP_AGE_MS) return { action: 'skip' }
  return { action: 'send', index: followupCount }
}

export const FOLLOWUP_COLUMNS =
  'followup_enabled, followup_delay_minutes, followup_max, followup_messages, followup_close_minutes, auto_close_after_order_minutes'

/**
 * Sends the ticket to Fechados on the AI's own initiative. Clears the
 * cart, cancels any pending auto-close, and turns a still-open funnel
 * deal into a lost one (a WON deal is untouched). Never throws.
 */
export async function closeConversationByAi(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string | null; reason: string },
): Promise<boolean> {
  try {
    const now = new Date().toISOString()
    const { data, error } = await db
      .from('conversations')
      .update({
        status: 'closed',
        closed_at: now,
        closed_by: null,
        close_reason: args.reason,
        ai_cart: [],
        ai_close_at: null,
        updated_at: now,
      })
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .neq('status', 'closed')
      .select('id')
    if (error) throw error
    if (args.contactId) await markOpenLeadDealLost(db, args.accountId, args.contactId)
    return (data ?? []).length > 0
  } catch (err) {
    console.error('[followup] closeConversationByAi failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** After a real order: schedule the auto-close if the account enabled it. Never throws. */
export async function scheduleAutoCloseAfterOrder(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  try {
    const { data } = await db
      .from('ai_configs')
      .select(`is_active, auto_reply_enabled, ${FOLLOWUP_COLUMNS}`)
      .eq('account_id', accountId)
      .maybeSingle()
    const row = data as (FollowupConfigRow & { is_active: boolean; auto_reply_enabled: boolean }) | null
    if (!row?.is_active || !row.auto_reply_enabled) return
    const minutes = row.auto_close_after_order_minutes
    if (!minutes) return
    await db
      .from('conversations')
      .update({ ai_close_at: new Date(Date.now() + minutes * 60_000).toISOString() })
      .eq('id', conversationId)
      .eq('account_id', accountId)
  } catch (err) {
    console.error('[followup] scheduleAutoCloseAfterOrder failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * The customer wrote again: a new silence window starts (nudges reset)
 * and any pending post-order close is pushed back so we never close a
 * chat the customer is still talking in. Never throws.
 */
export async function resetFollowupOnInbound(
  db: SupabaseClient,
  accountId: string,
  conversation: { id: string; ai_followup_count?: number | null; ai_close_at?: string | null },
): Promise<void> {
  try {
    const patch: Record<string, unknown> = {}
    if ((conversation.ai_followup_count ?? 0) > 0) {
      patch.ai_followup_count = 0
      patch.ai_followup_at = null
    }
    if (conversation.ai_close_at) {
      const { data } = await db
        .from('ai_configs')
        .select('auto_close_after_order_minutes')
        .eq('account_id', accountId)
        .maybeSingle()
      const minutes = (data as { auto_close_after_order_minutes: number | null } | null)?.auto_close_after_order_minutes
      patch.ai_close_at = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null
    }
    if (Object.keys(patch).length === 0) return
    await db.from('conversations').update(patch).eq('id', conversation.id).eq('account_id', accountId)
  } catch (err) {
    console.error('[followup] resetFollowupOnInbound failed:', err instanceof Error ? err.message : err)
  }
}

