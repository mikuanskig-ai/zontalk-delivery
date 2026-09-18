import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getMetaCapiPlatformCredentials, discoverSharedAssets } from '@/lib/integrations/meta-capi/discover-assets'

/**
 * GET /api/integrations/meta-capi/available-assets  (admin+)
 *
 * Lists every Pixel/WhatsApp Business Account any tenant has ever
 * shared with the platform's own Business Manager as a partner —
 * GLOBAL, not scoped to this account (Meta has no concept of our
 * tenants). The admin picks theirs by name in the UI, then
 * `POST /link` persists that choice against THIS account.
 */
export async function GET() {
  try {
    const { userId } = await requireRole('admin')

    const limit = checkRateLimit(`meta-capi-assets:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const creds = getMetaCapiPlatformCredentials()
    if (!creds) {
      return NextResponse.json(
        { error: 'A integração com a Meta ainda não foi configurada nesta plataforma.' },
        { status: 503 },
      )
    }

    const result = await discoverSharedAssets(creds)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 })
    }

    return NextResponse.json({
      pixels: result.pixels,
      whatsapp_business_accounts: result.whatsappBusinessAccounts,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
