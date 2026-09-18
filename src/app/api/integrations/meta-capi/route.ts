import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getMetaCapiPlatformCredentials } from '@/lib/integrations/meta-capi/discover-assets'

/**
 * GET /api/integrations/meta-capi
 *
 * Any member may read — reflects whether this account linked a
 * Pixel/WhatsApp Business Account and whether it's active.
 *
 * `platform_ready`/`platform_business_id` tell the UI whether the
 * "conectar" flow can even run at all right now — `platform_ready` is
 * false until `META_CAPI_SYSTEM_USER_TOKEN`/`META_CAPI_BUSINESS_ID`
 * are set on the server (see discover-assets.ts's doc for the whole
 * "partner" model this replaces per-tenant tokens with).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('meta_capi_configs')
      .select('pixel_id, pixel_name, whatsapp_business_account_id, whatsapp_business_account_name, is_active, test_event_code, linked_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[integrations/meta-capi GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Meta CAPI config' }, { status: 500 })
    }

    const creds = getMetaCapiPlatformCredentials()

    if (!data) {
      return NextResponse.json({
        configured: false,
        platform_ready: !!creds,
        platform_business_id: creds?.businessId ?? null,
      })
    }
    return NextResponse.json({
      configured: true,
      platform_ready: !!creds,
      platform_business_id: creds?.businessId ?? null,
      ...data,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/integrations/meta-capi  (admin+)
 *
 * Toggles `is_active` / sets `test_event_code` — patch-only-what's-sent,
 * same independence discipline as `/api/delivery/print-config`'s
 * `enabled`/`compact_print` toggles (a regression fixed there
 * 2026-09-07: two unrelated flags on one endpoint must never let
 * flipping one silently reset the other). Does NOT set pixel_id/
 * whatsapp_business_account_id — that's `POST /link`'s job, since
 * those come from a picked discovered asset, never typed by hand.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`meta-capi-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const hasActiveField = 'is_active' in body
    const hasTestCodeField = 'test_event_code' in body
    if (!hasActiveField && !hasTestCodeField) {
      return NextResponse.json({ error: 'Nothing to update — pass is_active or test_event_code' }, { status: 400 })
    }

    const { data: existing } = await supabase
      .from('meta_capi_configs')
      .select('id, pixel_id, whatsapp_business_account_id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing?.pixel_id || !existing.whatsapp_business_account_id) {
      return NextResponse.json({ error: 'Vincule um Pixel e uma Conta do WhatsApp Business antes.' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if (hasActiveField) patch.is_active = body.is_active === true
    if (hasTestCodeField) {
      const code = body.test_event_code
      if (code !== null && typeof code !== 'string') {
        return NextResponse.json({ error: 'test_event_code must be a string or null' }, { status: 400 })
      }
      patch.test_event_code = typeof code === 'string' ? code.trim() || null : null
    }

    const { error } = await supabase.from('meta_capi_configs').update(patch).eq('account_id', accountId)
    if (error) {
      console.error('[integrations/meta-capi PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to save Meta CAPI config' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/integrations/meta-capi  (admin+)
 *
 * "Desvincular" — clears the linked Pixel/WABA and deactivates. Never
 * touches `contacts.ad_attribution` (that's real, already-captured
 * click data, harmless to keep around) or the partner share itself in
 * Meta's Business Manager (the tenant controls that on their end).
 */
export async function DELETE() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`meta-capi-unlink:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await supabase
      .from('meta_capi_configs')
      .update({
        pixel_id: null,
        pixel_name: null,
        whatsapp_business_account_id: null,
        whatsapp_business_account_name: null,
        is_active: false,
        linked_at: null,
        linked_by: null,
      })
      .eq('account_id', accountId)
    if (error) {
      console.error('[integrations/meta-capi DELETE] update error:', error)
      return NextResponse.json({ error: 'Failed to unlink' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
