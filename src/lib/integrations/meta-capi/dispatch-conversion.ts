import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMetaConversion } from './send-conversion'
import { getMetaCapiPlatformCredentials } from './discover-assets'

export interface DispatchConversionArgs {
  db: SupabaseClient
  accountId: string
  contactId: string | null
  orderId: string
  /** Unidade cheia da moeda (ex.: 42.00) — mesma unidade de `delivery_orders.total`. */
  total: number
  currency: string
  eventSourceUrl?: string
}

/**
 * Fires the Meta "Purchase" conversion event for a real delivery order,
 * closing the CTWA (Clique-para-WhatsApp) ad funnel. Called from
 * `finalizeDeliveryOrder` right alongside the other best-effort side
 * effects (webhook dispatch, automations) — same contract: NEVER
 * throws, a failure here must never affect the sale itself.
 *
 * `skipped` covers every normal, expected case (feature not configured
 * at the platform level yet, this account hasn't linked a Pixel/WABA,
 * or — the most common case by far — this particular customer simply
 * didn't come from a WhatsApp ad click). Only escalates to a logged
 * error when everything needed was actually present and Meta itself
 * rejected the call.
 */
export async function dispatchMetaCapiConversion(args: DispatchConversionArgs): Promise<void> {
  try {
    if (!args.contactId) return

    const { data: config } = await args.db
      .from('meta_capi_configs')
      .select('pixel_id, whatsapp_business_account_id, is_active, test_event_code')
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (!config?.is_active || !config.pixel_id || !config.whatsapp_business_account_id) return

    const { data: contact } = await args.db
      .from('contacts')
      .select('ad_attribution')
      .eq('id', args.contactId)
      .maybeSingle()
    const adAttribution = contact?.ad_attribution as Record<string, unknown> | null
    const ctwaClid = typeof adAttribution?.ctwa_clid === 'string' ? adAttribution.ctwa_clid : null
    if (!ctwaClid) return // this customer didn't come from a WhatsApp ad click

    const creds = getMetaCapiPlatformCredentials()
    if (!creds) {
      console.error('[meta-capi] account has an active link but the platform-level credentials are unset (META_CAPI_SYSTEM_USER_TOKEN/META_CAPI_BUSINESS_ID)')
      return
    }

    const result = await sendMetaConversion({
      pixelId: config.pixel_id,
      whatsappBusinessAccountId: config.whatsapp_business_account_id,
      accessToken: creds.systemUserToken,
      testEventCode: config.test_event_code,
      ctwaClid,
      eventTime: Math.floor(Date.now() / 1000),
      value: args.total,
      currency: args.currency,
      eventSourceUrl: args.eventSourceUrl,
    })

    if (result.ok) {
      console.info('[meta-capi] conversion sent', { accountId: args.accountId, orderId: args.orderId })
    } else {
      console.error('[meta-capi] Meta rejected the conversion event', {
        accountId: args.accountId,
        orderId: args.orderId,
        detail: result.error,
      })
    }
  } catch (err) {
    console.error('[meta-capi] dispatch failed:', err)
  }
}
