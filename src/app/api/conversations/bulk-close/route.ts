import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MAX_IDS = 1000
const CHUNK = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/conversations/bulk-close  (agent+)
 *
 * Body: { conversation_ids: string[] }  (max 1000)
 *
 * Closes many tickets at once (Inbox → "Fechar todas" on the ABERTO /
 * PENDENTE / CHATBOT tabs). Same audit stamps as the single-ticket
 * close in /[conversationId]/attendance (status, closed_at, closed_by,
 * close_reason) — assignment is left untouched. Already-closed tickets
 * are skipped, so a stale client list never rewrites closed_at of a
 * ticket someone closed in the meantime. RLS-scoped client + explicit
 * account_id filter, so ids from another account are simply ignored.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ticket-bulk-close:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const ids: unknown = body?.conversation_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'conversation_ids must be a non-empty array' }, { status: 400 })
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `at most ${MAX_IDS} conversations per request` }, { status: 400 })
    }
    if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
      return NextResponse.json({ error: 'conversation_ids must be UUIDs' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const closedIds: string[] = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('conversations')
        .update({
          status: 'closed',
          closed_at: now,
          closed_by: userId,
          close_reason: 'bulk_close',
          updated_at: now,
        })
        .in('id', (ids as string[]).slice(i, i + CHUNK))
        .eq('account_id', accountId)
        .neq('status', 'closed')
        .select('id')
      if (error) {
        console.error('[conversations/bulk-close] update error:', error)
        return NextResponse.json(
          { error: 'Failed to close conversations', closed: closedIds.length, closed_ids: closedIds },
          { status: 500 },
        )
      }
      closedIds.push(...(data ?? []).map((r: { id: string }) => r.id))
    }

    return NextResponse.json({ success: true, closed: closedIds.length, closed_ids: closedIds })
  } catch (err) {
    return toErrorResponse(err)
  }
}
