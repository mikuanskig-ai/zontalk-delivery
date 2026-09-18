import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getMetaCapiPlatformCredentials } from '@/lib/integrations/meta-capi/discover-assets'
import { sendMetaConversion } from '@/lib/integrations/meta-capi/send-conversion'

/**
 * POST /api/integrations/meta-capi/test  (admin+)
 *
 * "Enviar evento de teste" — lets an admin verify a linked Pixel/WABA
 * actually accepts events, without needing a real WhatsApp-ad customer
 * to place a real order first. Requires `test_event_code` to be set
 * (Meta's Events Manager → Test events tab) — that's the whole point:
 * it routes this synthetic event to Meta's test pipeline instead of
 * mixing a fake click into real ad-optimization data. The `ctwa_clid`
 * sent is a synthetic placeholder — Meta's test pipeline validates
 * shape, not authenticity.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`meta-capi-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config } = await supabase
      .from('meta_capi_configs')
      .select('pixel_id, whatsapp_business_account_id, test_event_code')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.pixel_id || !config.whatsapp_business_account_id) {
      return NextResponse.json({ error: 'Vincule um Pixel e uma Conta do WhatsApp Business antes.' }, { status: 400 })
    }
    if (!config.test_event_code) {
      return NextResponse.json(
        { error: 'Defina um código de teste (Gerenciador de Eventos da Meta → aba Testar eventos) antes de testar.' },
        { status: 400 },
      )
    }

    const creds = getMetaCapiPlatformCredentials()
    if (!creds) {
      return NextResponse.json(
        { error: 'A integração com a Meta ainda não foi configurada nesta plataforma.' },
        { status: 503 },
      )
    }

    const result = await sendMetaConversion({
      pixelId: config.pixel_id,
      whatsappBusinessAccountId: config.whatsapp_business_account_id,
      accessToken: creds.systemUserToken,
      testEventCode: config.test_event_code,
      ctwaClid: `test_${randomUUID()}`,
      eventTime: Math.floor(Date.now() / 1000),
      value: 1,
      currency: 'BRL',
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
