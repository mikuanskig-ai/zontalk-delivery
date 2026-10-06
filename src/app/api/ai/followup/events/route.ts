import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const MAX_EVENTS = 100

interface EventRow {
  id: string
  kind: 'nudge' | 'close_no_reply'
  step: number | null
  status: 'sent' | 'failed'
  error: string | null
  message_text: string | null
  created_at: string
  conversation_id: string | null
  contact_id: string | null
  contacts: { name: string | null } | null
  conversations: { status: string } | null
}

/**
 * GET /api/ai/followup/events  (admin+)
 *
 * The most recent follow-up actions for this account: each nudge sent or
 * failed, and each conversation closed for silence. For every event it also
 * reports whether the customer wrote again afterwards — the closest thing
 * to "did it work" the WhatsApp gateway lets us observe (it does not send
 * per-message delivery receipts for bot messages).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data, error } = await supabase
      .from('ai_followup_events')
      .select(
        'id, kind, step, status, error, message_text, created_at, conversation_id, contact_id, contacts(name), conversations(status)',
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MAX_EVENTS)
    if (error) {
      console.error('[ai/followup/events GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load follow-up history' }, { status: 500 })
    }

    const events = (data ?? []) as unknown as EventRow[]
    const convIds = [...new Set(events.map((e) => e.conversation_id).filter((v): v is string => !!v))]
    const oldest = events.length ? events[events.length - 1]!.created_at : null

    // Customer messages in those conversations since the oldest event — one query, bucketed in JS.
    const repliedAfter = new Map<string, number[]>()
    if (convIds.length && oldest) {
      const { data: replies, error: repliesErr } = await supabase
        .from('messages')
        .select('conversation_id, created_at')
        .in('conversation_id', convIds)
        .eq('sender_type', 'customer')
        .gte('created_at', oldest)
      if (repliesErr) {
        console.error('[ai/followup/events GET] replies fetch error:', repliesErr)
      } else {
        for (const r of (replies ?? []) as { conversation_id: string; created_at: string }[]) {
          const list = repliedAfter.get(r.conversation_id) ?? []
          list.push(new Date(r.created_at).getTime())
          repliedAfter.set(r.conversation_id, list)
        }
      }
    }

    return NextResponse.json({
      events: events.map((e) => {
        const at = new Date(e.created_at).getTime()
        const replies = e.conversation_id ? repliedAfter.get(e.conversation_id) ?? [] : []
        return {
          id: e.id,
          kind: e.kind,
          step: e.step,
          status: e.status,
          error: e.error,
          message_text: e.message_text,
          created_at: e.created_at,
          conversation_id: e.conversation_id,
          contact_id: e.contact_id,
          contact_name: e.contacts?.name ?? null,
          conversation_status: e.conversations?.status ?? null,
          customer_replied: replies.some((t) => t > at),
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
