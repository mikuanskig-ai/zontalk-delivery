import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/delivery/print-config
 *
 * Any member may read the config so the UI can reflect whether
 * auto-print is on and when the (not-yet-built) local agent last
 * polled for jobs.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('print_configs')
      .select('enabled, last_polled_at, compact_print')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[delivery/print-config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load print config' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({ configured: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/print-config  (admin+)
 *
 * Toggles auto-print for the account.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-print-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    // `enabled` and `compact_print` are two independent toggles in the
    // UI (auto-print on/off; compact ticket layout on/off), each POSTing
    // here on its own — only patch a field when the caller actually sent
    // it, or flipping one toggle would silently reset the other back to
    // whatever `=== true` defaults an absent field to (false).
    const hasEnabledField = 'enabled' in body
    const hasCompactField = 'compact_print' in body
    if (!hasEnabledField && !hasCompactField) {
      return NextResponse.json({ error: 'Nothing to update — pass enabled or compact_print' }, { status: 400 })
    }
    const patch: Record<string, unknown> = {}
    if (hasEnabledField) patch.enabled = body.enabled === true
    if (hasCompactField) patch.compact_print = body.compact_print === true

    const { data: existing } = await supabase
      .from('print_configs')
      .select('id, enabled, compact_print')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      const { error } = await supabase
        .from('print_configs')
        .update(patch)
        .eq('account_id', accountId)
      if (error) {
        console.error('[delivery/print-config POST] update error:', error)
        return NextResponse.json({ error: 'Failed to save print config' }, { status: 500 })
      }
    } else {
      // Row doesn't exist yet — fall back to the schema defaults
      // (enabled: false, compact_print: false) for whichever field
      // this particular call didn't send.
      const { error } = await supabase
        .from('print_configs')
        .insert({ account_id: accountId, enabled: false, compact_print: false, ...patch })
      if (error) {
        console.error('[delivery/print-config POST] insert error:', error)
        return NextResponse.json({ error: 'Failed to save print config' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      enabled: hasEnabledField ? patch.enabled : (existing?.enabled ?? false),
      compact_print: hasCompactField ? patch.compact_print : (existing?.compact_print ?? false),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
