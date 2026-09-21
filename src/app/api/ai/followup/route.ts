import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { DEFAULT_FOLLOWUP_MESSAGES, FOLLOWUP_COLUMNS, parseFollowupSettings } from '@/lib/ai/followup-state'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/followup  (any member)
 *
 * The account's follow-up / auto-close settings (migration 084),
 * defaults filled. `configured: false` when AI itself isn't set up yet
 * (the settings live on `ai_configs`, so there is nothing to attach to).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_configs')
      .select(FOLLOWUP_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[ai/followup GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load follow-up settings' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ configured: false, default_messages: DEFAULT_FOLLOWUP_MESSAGES })

    const settings = parseFollowupSettings(data as never)
    const custom = Array.isArray((data as { followup_messages: unknown }).followup_messages)
      ? ((data as { followup_messages: unknown[] }).followup_messages as string[])
      : []
    return NextResponse.json({
      configured: true,
      followup_enabled: settings.enabled,
      followup_delay_minutes: settings.delayMinutes,
      followup_max: settings.max,
      followup_messages: custom, // only what the admin typed; blanks fall back to the defaults below
      followup_close_minutes: settings.closeMinutes,
      auto_close_after_order_minutes: settings.autoCloseAfterOrderMinutes,
      default_messages: DEFAULT_FOLLOWUP_MESSAGES,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function intInRange(value: unknown, min: number, max: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  return i >= min && i <= max ? i : null
}

/**
 * POST /api/ai/followup  (admin+)
 *
 * Narrow sibling of POST /api/ai/config (same reasoning as
 * config/daily-menu): the shared route resets every other toggle when a
 * field is omitted, so follow-up settings get their own endpoint.
 * Requires an existing ai_configs row.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const delay = intInRange(body.followup_delay_minutes, 5, 720)
    if (delay === null) return bad('followup_delay_minutes must be between 5 and 720')
    const max = intInRange(body.followup_max, 1, 3)
    if (max === null) return bad('followup_max must be between 1 and 3')
    const closeMinutes = intInRange(body.followup_close_minutes, 0, 1440)
    if (closeMinutes === null) return bad('followup_close_minutes must be between 0 and 1440')

    let autoClose: number | null = null
    if (body.auto_close_after_order_minutes !== null && body.auto_close_after_order_minutes !== undefined && body.auto_close_after_order_minutes !== '') {
      autoClose = intInRange(body.auto_close_after_order_minutes, 1, 720)
      if (autoClose === null) return bad('auto_close_after_order_minutes must be between 1 and 720 (or empty to turn off)')
    }

    let messages: string[] | null = null
    if (body.followup_messages !== undefined && body.followup_messages !== null) {
      if (!Array.isArray(body.followup_messages) || body.followup_messages.length > 3) {
        return bad('followup_messages must be an array of up to 3 texts')
      }
      const cleaned = body.followup_messages.map((m: unknown) => (typeof m === 'string' ? m.trim() : ''))
      if (cleaned.some((m: string) => m.length > 600)) return bad('each follow-up message can have at most 600 characters')
      // Keep positions (blank = "use the default for this nudge"), drop trailing blanks.
      while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop()
      messages = cleaned.length > 0 ? cleaned : null
    }

    const { data: existing } = await supabase.from('ai_configs').select('id').eq('account_id', accountId).maybeSingle()
    if (!existing) return bad('Configure a IA em Agentes de IA antes de ativar o follow-up.')

    const { error } = await supabase
      .from('ai_configs')
      .update({
        followup_enabled: body.followup_enabled === true,
        followup_delay_minutes: delay,
        followup_max: max,
        followup_messages: messages,
        followup_close_minutes: closeMinutes,
        auto_close_after_order_minutes: autoClose,
      })
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/followup POST] update error:', error)
      return NextResponse.json({ error: 'Failed to save follow-up settings' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
