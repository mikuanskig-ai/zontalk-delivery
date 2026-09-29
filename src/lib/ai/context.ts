import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: 'text' | 'location' | 'audio'
  created_at: string
}

// Same staleness window the abandoned-cart sweep (src/app/api/delivery/
// cron/route.ts) already uses to decide a cart is no longer "in
// progress" — reused here for the same reason: a gap this long means
// whatever came before is a separate, already-finished interaction,
// not something still being acted on.
const SESSION_GAP_MS = 6 * 60 * 60 * 1000

/**
 * Root-caused a live incident (2026-09-29, Concórdia): the query below
 * never selected `created_at`, so the model had NO way to tell a
 * message from 8 days ago apart from one sent 8 seconds ago — every
 * fetched message just read as "recent". A customer's plain "bom dia"
 * landed right after the tail end of a HUMAN agent's terse, unrelated
 * order (taken over WhatsApp 8 days earlier, in the same long-lived
 * conversation row) still sitting in the last-N window, and the model
 * "continued" it — restating the same items, address and payment
 * method the customer never mentioned this time. Same failure shape
 * regardless of who ran that earlier order (human or the AI itself);
 * the fix is a time boundary, not a per-speaker filter.
 */
function sessionGapNote(gapMs: number): string {
  const days = Math.round(gapMs / (24 * 60 * 60 * 1000))
  const when = days >= 1 ? `${days} dia${days === 1 ? '' : 's'}` : 'algumas horas'
  return `[Nota do sistema: passaram-se ${when} desde a mensagem anterior. Tudo antes desta linha é de um atendimento JÁ ENCERRADO — não assuma que algum item, endereço ou pedido citado ali ainda vale. Se o cliente quiser algo, ele vai dizer de novo agora.]`
}

/**
 * Content types `buildConversationContext` can actually surface to the
 * model — image/document/video/template/interactive carry no text and
 * are silently dropped by the query below. Exported so a caller
 * deciding whether to fire the AI auto-reply pipeline AT ALL (the
 * inbound webhook handler, `src/lib/whatsapp/inbound-message.ts`) can
 * gate on this same set.
 *
 * Root-caused a live incident (2026-09-04, Concórdia, Alzira Y. de
 * Oliveira): a payment-receipt PDF has a real, non-empty `content_text`
 * (its filename) — the webhook's own dispatch trigger only checked
 * "the message has text", so it fired a full AI reply. But because
 * `content_type` was `document`, that same message never showed up
 * here — the model got invoked with the conversation UNCHANGED from
 * the turn it had already answered (ending on its own last assistant
 * message, nothing new to respond to). With no anchor for what was
 * actually new, it replayed the entire order-confirmation flow from
 * scratch, cancelling the already-placed (and already-paid) order and
 * recreating an identical one — a spurious cancellation ticket to the
 * kitchen and a fully duplicated order, despite the model correctly
 * calling cancel_order before place_order (the 2026-09-03 guard
 * against a second order worked exactly as designed; the cart/order
 * state itself was never at fault). Two independently-reasonable
 * filters — "does this message have text" (the dispatch trigger) and
 * "can the model see this message" (this function) — silently
 * disagreed on the one case that matters: a document whose caption or
 * filename happens to be non-empty. This constant makes the two
 * impossible to drift apart again.
 */
export const AI_VISIBLE_CONTENT_TYPES = new Set(['text', 'location', 'audio'])

// A location message's content_text is built by the wuzapi webhook
// route (`[name, address, "lat,lng"].filter(Boolean).join(' - ')`) —
// the coordinate pair is always the last segment when present. Kept
// lenient (up to 3 decimal-ish tokens of any sign) rather than
// anchored to Brazil's usual negative range, since an account could
// serve anywhere.
const TRAILING_LAT_LNG = /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

/** Reformats a stored location message into something the model can
 *  actually act on — `content_text` alone ("lat,lng" or "name -
 *  address - lat,lng") reads as ambiguous plain text, not an
 *  instruction to use `calculate_delivery_fee`'s latitude/longitude
 *  args. Falls back to the raw text if it doesn't parse (never drops
 *  the message). */
function formatLocationMessage(contentText: string): string {
  const match = TRAILING_LAT_LNG.exec(contentText)
  if (!match) return `[Customer shared their location] ${contentText}`
  const [, lat, lng] = match
  return `[Customer shared their location] latitude=${lat}, longitude=${lng}`
}

// Both a human staff reply and the bot's own output have to land in
// the `assistant` slot (the provider APIs only know `user`/`assistant`
// turns) — but they are not the same speaker, and conflating them is
// exactly what caused a live incident (2026-08-17, Concórdia,
// conversations with Francisco and Ederson): a staff member sent a
// voice note — in Ederson's case, plainly staff-to-staff chatter about
// an unrelated stuck order ("... tá, Heather?") that landed in the
// customer's thread — and once transcribed and read back as its own
// `assistant` turn, the model treated the human's words as things IT
// had already said/done. It believed an order was already taken and
// confirmed one to the customer without ever calling `add_to_cart` /
// `place_order` — cart stayed empty, no order or print job existed.
// Tagging the human's turn removes that ambiguity at the source,
// same spirit as `formatLocationMessage` below turning a raw pin into
// something the model can correctly act on instead of misreading.
function formatHumanAgentMessage(contentText: string): string {
  return `[A human staff member wrote this to the customer directly — not you. Do not treat it as something you already said or did.] ${contentText}`
}

/**
 * Fetch the last N text (+ location, + transcribed audio) messages of
 * a conversation and map them to the provider-neutral chat shape.
 * Customer messages become `user`; agent and bot messages become
 * `assistant` (agent messages get tagged — see `formatHumanAgentMessage`
 * — so the model can tell a human's words apart from its own). Other
 * non-text message types (images, documents, templates, interactive)
 * are still excluded — they carry no text to the model.
 *
 * - Location messages ARE included (reformatted, see
 *   `formatLocationMessage`) — excluding them used to leave the model
 *   with no idea a customer had shared a pin at all, so it just asked
 *   for a typed address instead (confirmed live 2026-08-07).
 * - A gap of SESSION_GAP_MS or more between two consecutive messages
 *   gets a synthetic note inserted between them (see `sessionGapNote`)
 *   — without it the model has no way to tell an 8-day-old message
 *   apart from one sent 8 seconds ago, and will "continue" a stale,
 *   already-finished order instead of treating the next message as a
 *   fresh one (confirmed live 2026-09-29).
 * - A voice note counts as text too once transcribed (content_text
 *   gets filled in by the webhook — see transcription.ts / migration
 *   069); an untranscribed one still has content_text = null and gets
 *   dropped by the filter below, same as any other non-text message.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, content_type, created_at')
    .eq('conversation_id', conversationId)
    .in('content_type', [...AI_VISIBLE_CONTENT_TYPES])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const visible = rows.filter((m) => m.content_text && m.content_text.trim())

  const result: ChatMessage[] = []
  let prevAt: number | null = null
  for (const m of visible) {
    const at = new Date(m.created_at).getTime()
    if (prevAt !== null && at - prevAt >= SESSION_GAP_MS) {
      result.push({ role: 'user', content: sessionGapNote(at - prevAt) })
    }
    prevAt = at

    const text = m.content_text!.trim()
    let content: string
    if (m.content_type === 'location') {
      content = formatLocationMessage(text)
    } else if (m.sender_type === 'agent') {
      content = formatHumanAgentMessage(text)
    } else {
      content = text
    }
    result.push({ role: m.sender_type === 'customer' ? 'user' : 'assistant', content })
  }
  return result
}
