import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { getAiBusinessHours, isWithinBusinessHours } from '@/lib/delivery/business-hours'
import {
  FOLLOWUP_COLUMNS,
  closeConversationByAi,
  decideFollowup,
  parseFollowupSettings,
  renderFollowupText,
  type CartLine,
  type FollowupConfigRow,
} from './followup-state'

// Cron phase of the AI follow-up / auto-close feature. The rules,
// settings parsing and per-conversation state live in followup-state.ts
// (light imports, safe to use from the webhook path); this file only
// adds the part that actually sends WhatsApp messages.

export interface FollowupSweepResult {
  sent: number
  closedNoReply: number
  autoClosed: number
}

interface SweepConv {
  id: string
  user_id: string
  contact_id: string
  last_message_at: string | null
  ai_cart: unknown
  ai_followup_count: number
}

/**
 * Cron phase (runs with the 5-min delivery cron). Per opted-in account:
 *   a) post-order auto-close for due `ai_close_at`;
 *   b) follow-up nudges / close-after-silence for tickets with an open cart.
 * Best-effort per ticket — one failure never blocks the rest.
 */
export async function runFollowupSweep(db: SupabaseClient, nowMs: number = Date.now()): Promise<FollowupSweepResult> {
  const result: FollowupSweepResult = { sent: 0, closedNoReply: 0, autoClosed: 0 }

  const { data: accounts, error } = await db
    .from('ai_configs')
    .select(`account_id, ${FOLLOWUP_COLUMNS}`)
    .eq('is_active', true)
    .eq('auto_reply_enabled', true)
    .or('followup_enabled.eq.true,auto_close_after_order_minutes.not.is.null')
  if (error) {
    console.error('[followup-sweep] config scan failed:', error.message)
    return result
  }

  for (const row of (accounts ?? []) as (FollowupConfigRow & { account_id: string })[]) {
    const accountId = row.account_id
    const settings = parseFollowupSettings(row)
    try {
      // a) post-order auto-close
      if (settings.autoCloseAfterOrderMinutes) {
        const { data: due } = await db
          .from('conversations')
          .select('id, contact_id, status, ai_cart')
          .eq('account_id', accountId)
          .not('ai_close_at', 'is', null)
          .lte('ai_close_at', new Date(nowMs).toISOString())
          .limit(100)
        for (const c of (due ?? []) as { id: string; contact_id: string; status: string; ai_cart: unknown }[]) {
          const cartHasItems = Array.isArray(c.ai_cart) && c.ai_cart.length > 0
          if (c.status !== 'pending' || cartHasItems) {
            // A human took over, or the customer is ordering again: don't close it.
            await db.from('conversations').update({ ai_close_at: null }).eq('id', c.id)
            continue
          }
          if (await closeConversationByAi(db, { accountId, conversationId: c.id, contactId: c.contact_id, reason: 'auto_after_order' })) {
            result.autoClosed++
          }
        }
      }

      // b) follow-ups
      if (!settings.enabled) continue
      const aiHours = await getAiBusinessHours(db, accountId)
      const withinHours = !aiHours?.enabled || isWithinBusinessHours(aiHours.hours, aiHours.timezone)

      const { data: convs } = await db
        .from('conversations')
        .select('id, user_id, contact_id, last_message_at, ai_cart, ai_followup_count')
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .eq('ai_autoreply_disabled', false)
        .is('assigned_agent_id', null)
        .neq('ai_cart', '[]')
        .limit(200)

      for (const c of (convs ?? []) as SweepConv[]) {
        if (!c.last_message_at || !Array.isArray(c.ai_cart) || c.ai_cart.length === 0) continue

        const { data: last } = await db
          .from('messages')
          .select('sender_type')
          .eq('conversation_id', c.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const decision = decideFollowup({
          nowMs,
          lastMessageAtMs: new Date(c.last_message_at).getTime(),
          lastMessageFromCustomer: (last as { sender_type: string } | null)?.sender_type === 'customer',
          followupCount: c.ai_followup_count ?? 0,
          settings,
          withinHours,
        })

        if (decision.action === 'close') {
          if (await closeConversationByAi(db, { accountId, conversationId: c.id, contactId: c.contact_id, reason: 'followup_no_reply' })) {
            result.closedNoReply++
          }
        } else if (decision.action === 'send') {
          // Claim the slot first (conditional on the count we read) so two
          // overlapping sweeps can never send the same nudge twice.
          const { data: claimed } = await db
            .from('conversations')
            .update({ ai_followup_count: (c.ai_followup_count ?? 0) + 1, ai_followup_at: new Date(nowMs).toISOString() })
            .eq('id', c.id)
            .eq('ai_followup_count', c.ai_followup_count ?? 0)
            .select('id')
          if (!claimed || claimed.length === 0) continue

          const { data: contact } = await db.from('contacts').select('name').eq('id', c.contact_id).maybeSingle()
          const template = settings.messages[Math.min(decision.index, settings.messages.length - 1)]!
          const text = renderFollowupText(template, {
            name: (contact as { name: string | null } | null)?.name ?? null,
            cart: c.ai_cart as CartLine[],
          })
          try {
            await engineSendText({
              accountId,
              userId: c.user_id,
              conversationId: c.id,
              contactId: c.contact_id,
              text,
              aiGenerated: true,
            })
            result.sent++
          } catch (err) {
            console.error(`[followup-sweep] send failed for conversation ${c.id}:`, err instanceof Error ? err.message : err)
          }
        }
      }
    } catch (err) {
      console.error(`[followup-sweep] account ${accountId} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return result
}
