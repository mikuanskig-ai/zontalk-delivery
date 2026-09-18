/**
 * Envia o evento de conversão pra Meta Conversions API quando um pedido
 * de delivery é criado de verdade — fecha o funil do anúncio
 * Clique-para-WhatsApp (CTWA).
 *
 * Shape idêntico ao já confirmado no zontalk-crm (developers.facebook.com/
 * docs/marketing-api/conversions-api/business-messaging/) —
 * `action_source: "business_messaging"`, `messaging_channel: "whatsapp"`,
 * `user_data` com `whatsapp_business_account_id` + `ctwa_clid`.
 *
 * Diferença do zontalk-crm: `accessToken` aqui é sempre o token de
 * Usuário de Sistema DA PLATAFORMA (env `META_CAPI_SYSTEM_USER_TOKEN`),
 * nunca um token por conta — ver a migration 081 pro porquê ("modelo
 * parceiro": o cliente compartilha o Pixel com o Business Manager do
 * Zontalk em vez de gerar/colar um token próprio).
 *
 * Host fixo nosso (graph.facebook.com) — nunca uma URL configurável
 * pelo tenant.
 */
const GRAPH_API_VERSION = 'v21.0'
const TIMEOUT_MS = 10_000

export interface MetaConversionInput {
  pixelId: string
  whatsappBusinessAccountId: string
  accessToken: string
  testEventCode?: string | null
  ctwaClid: string
  /** Unix seconds — quando o pedido foi criado (não quando o evento é enviado). */
  eventTime: number
  /** Valor em unidade cheia da moeda (ex.: 42.00) — mesma unidade de
   *  `delivery_orders.total` (NUMERIC(12,2), não centavos). */
  value: number | null
  currency: string | null
  /** URL do pedido/conversa no painel — Meta aceita opcionalmente pra contexto. */
  eventSourceUrl?: string
}

export type MetaConversionResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string }

interface MetaErrorEnvelope {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    error_user_msg?: string
    error_data?: unknown
  }
}

/** `message` sozinho costuma ser genérico demais ("Invalid parameter");
 *  `error_user_msg`/`error_data` são mais específicos quando presentes. */
function formatMetaError(parsed: MetaErrorEnvelope | null, status: number): string {
  const e = parsed?.error
  if (!e) return `meta_capi_${status}`
  const parts = [e.error_user_msg, e.message].filter(
    (v, i, arr): v is string => typeof v === 'string' && v.length > 0 && arr.indexOf(v) === i,
  )
  const base = parts.join(' — ') || `meta_capi_${status}`
  const extra: string[] = []
  if (e.code != null) extra.push(`code=${e.code}`)
  if (e.error_subcode != null) extra.push(`subcode=${e.error_subcode}`)
  if (e.error_data != null) extra.push(`data=${JSON.stringify(e.error_data)}`)
  return extra.length > 0 ? `${base} (${extra.join(', ')})` : base
}

export async function sendMetaConversion(input: MetaConversionInput): Promise<MetaConversionResult> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(input.pixelId)}/events`

  const event: Record<string, unknown> = {
    event_name: 'Purchase',
    event_time: input.eventTime,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      whatsapp_business_account_id: input.whatsappBusinessAccountId,
      ctwa_clid: input.ctwaClid,
    },
  }
  if (input.value != null) {
    event.custom_data = {
      currency: input.currency ?? 'BRL',
      value: input.value,
    }
  }
  if (input.eventSourceUrl) {
    event.event_source_url = input.eventSourceUrl
  }

  const body: Record<string, unknown> = {
    data: [event],
    access_token: input.accessToken,
  }
  if (input.testEventCode) {
    body.test_event_code = input.testEventCode
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.ok) return { ok: true }

    const parsed = (await res.json().catch(() => null)) as MetaErrorEnvelope | null
    // 4xx = credencial/payload ruim, não adianta tentar de novo sozinho.
    // 5xx/timeout = transiente.
    const retryable = res.status >= 500
    return { ok: false, retryable, error: formatMetaError(parsed, res.status) }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return { ok: false, retryable: true, error: isTimeout ? 'timeout' : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}
