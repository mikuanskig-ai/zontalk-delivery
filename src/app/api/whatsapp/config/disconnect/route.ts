import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import * as wuzapiApi from '@/lib/whatsapp/wuzapi-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/whatsapp/config/disconnect  (admin+)
 *
 * Added 2026-09-14 — pedido do Eder: até aqui a ÚNICA ação disponível
 * ("Redefinir configuração") tanto desconectava a sessão do WuzAPI
 * quanto apagava contatos/conversas/negócios da conta inteira, e o
 * próprio diálogo de confirmação chamava isso de "Desconectar" mesmo
 * apagando tudo — confuso e perigoso pra quem só queria trocar de
 * aparelho.
 *
 * Este endpoint faz só a metade não-destrutiva: desloga a sessão do
 * WuzAPI (best-effort — uma falha do lado do WuzAPI nunca deve travar
 * o estado local) e marca o canal como desconectado. NÃO apaga
 * contatos, conversas, mensagens ou negócios, e NÃO apaga a própria
 * linha de `whatsapp_config` — o nome da instância e o token continuam
 * salvos, então reconectar depois é só escanear o QR code de novo, sem
 * perder histórico nenhum.
 *
 * `DELETE /api/whatsapp/config` ("Excluir canal") continua sendo a
 * ação destrutiva de verdade, agora com o rótulo certo na UI.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-disconnect:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('id, wuzapi_base_url, wuzapi_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[whatsapp/config/disconnect] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    if (!config) {
      return NextResponse.json(
        { error: 'No WhatsApp channel configured for this account.' },
        { status: 404 },
      )
    }

    if (config.wuzapi_base_url && config.wuzapi_token) {
      try {
        await wuzapiApi.logoutSession({
          baseUrl: config.wuzapi_base_url,
          token: decrypt(config.wuzapi_token),
        })
      } catch (err) {
        console.error(
          '[whatsapp/config/disconnect] wuzapi logout failed (continuing with local state update):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { error: updateErr } = await supabase
      .from('whatsapp_config')
      .update({ status: 'disconnected', connected_at: null })
      .eq('id', config.id)
    if (updateErr) {
      console.error('[whatsapp/config/disconnect] update error:', updateErr)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
