import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/integrations/meta-capi/link  (admin+)
 *
 * Persists the Pixel/WhatsApp Business Account the admin picked from
 * `GET /available-assets` against THIS account, and turns the
 * integration on. Both ids+names are expected to come from that list
 * (the UI never lets the admin type an id by hand) — validated here as
 * non-empty strings, not re-verified against the discovery list again
 * (a stale pick just fails at send time with Meta's own error, same as
 * any other "asset no longer shared" case would).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`meta-capi-link:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const { pixel_id, pixel_name, whatsapp_business_account_id, whatsapp_business_account_name } = body
    if (typeof pixel_id !== 'string' || !pixel_id.trim()) return bad('pixel_id is required')
    if (typeof pixel_name !== 'string' || !pixel_name.trim()) return bad('pixel_name is required')
    if (typeof whatsapp_business_account_id !== 'string' || !whatsapp_business_account_id.trim()) {
      return bad('whatsapp_business_account_id is required')
    }
    if (typeof whatsapp_business_account_name !== 'string' || !whatsapp_business_account_name.trim()) {
      return bad('whatsapp_business_account_name is required')
    }

    const row = {
      account_id: accountId,
      pixel_id: pixel_id.trim(),
      pixel_name: pixel_name.trim(),
      whatsapp_business_account_id: whatsapp_business_account_id.trim(),
      whatsapp_business_account_name: whatsapp_business_account_name.trim(),
      is_active: true,
      linked_at: new Date().toISOString(),
      linked_by: userId,
    }

    const { data: existing } = await supabase
      .from('meta_capi_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const { error } = existing
      ? await supabase.from('meta_capi_configs').update(row).eq('account_id', accountId)
      : await supabase.from('meta_capi_configs').insert(row)

    if (error) {
      console.error('[integrations/meta-capi/link POST] write error:', error)
      return NextResponse.json({ error: 'Failed to link Meta CAPI' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
