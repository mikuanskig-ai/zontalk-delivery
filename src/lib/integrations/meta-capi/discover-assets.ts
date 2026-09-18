/**
 * Lists the Pixels and WhatsApp Business Accounts other businesses have
 * shared with the PLATFORM's own Business Manager as a partner asset
 * (Business Settings → Partners → Add partner → give access to an
 * asset) — this is what lets a tenant connect Meta CAPI without ever
 * typing a Pixel ID or generating/pasting an access token: they just
 * add our Business Manager as a partner once, and this file finds what
 * they shared.
 *
 * ⚠️ NOT CONFIRMED LIVE YET — same caution as the CTWA attribution
 * capture (see migration 081's doc comment). The edge names below
 * (`client_pixels`, `client_whatsapp_business_accounts`) are per Meta's
 * Business Manager API docs; verify the exact response shape against a
 * real partner share once `META_CAPI_SYSTEM_USER_TOKEN` /
 * `META_CAPI_BUSINESS_ID` are actually set, and adjust field names here
 * if Meta's response differs. Every call below surfaces Meta's own
 * error message on failure rather than swallowing it, specifically so
 * a wrong edge/field name is easy to spot and fix in one pass.
 */
const GRAPH_API_VERSION = 'v21.0'
const TIMEOUT_MS = 10_000

export interface MetaCapiPlatformCredentials {
  systemUserToken: string
  businessId: string
}

/** Reads the platform-level credentials from the environment. Returns
 *  null (never throws) when either is unset — every caller treats that
 *  as "feature not configured yet," same "no row = off" convention as
 *  every other integration in this codebase. There is NO per-account
 *  fallback: this is deliberately a single, platform-wide credential. */
export function getMetaCapiPlatformCredentials(): MetaCapiPlatformCredentials | null {
  const systemUserToken = process.env.META_CAPI_SYSTEM_USER_TOKEN
  const businessId = process.env.META_CAPI_BUSINESS_ID
  if (!systemUserToken || !businessId) return null
  return { systemUserToken, businessId }
}

export interface DiscoveredAsset {
  id: string
  name: string
}

export interface DiscoverAssetsResult {
  pixels: DiscoveredAsset[]
  whatsappBusinessAccounts: DiscoveredAsset[]
}

export type DiscoverAssetsOutcome =
  | ({ ok: true } & DiscoverAssetsResult)
  | { ok: false; error: string }

interface MetaListEnvelope {
  data?: { id?: string; name?: string }[]
  error?: { message?: string; error_user_msg?: string }
}

async function fetchAssetList(
  businessId: string,
  edge: 'client_pixels' | 'client_whatsapp_business_accounts',
  accessToken: string,
): Promise<{ ok: true; assets: DiscoveredAsset[] } | { ok: false; error: string }> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(businessId)}/${edge}?fields=id,name&access_token=${encodeURIComponent(accessToken)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const parsed = (await res.json().catch(() => null)) as MetaListEnvelope | null
    if (!res.ok) {
      const msg = parsed?.error?.error_user_msg || parsed?.error?.message || `meta_capi_${res.status}`
      return { ok: false, error: `${edge}: ${msg}` }
    }
    const assets = (parsed?.data ?? [])
      .filter((row): row is { id: string; name: string } => typeof row.id === 'string' && typeof row.name === 'string')
      .map((row) => ({ id: row.id, name: row.name }))
    return { ok: true, assets }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return { ok: false, error: `${edge}: ${isTimeout ? 'timeout' : String(err)}` }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetches both lists in parallel. This is intentionally GLOBAL, not
 * scoped to one zdelivery account — Meta has no concept of our tenants,
 * it only knows "assets shared with this Business Manager." The caller
 * (the settings API route) is what lets an admin pick which of these
 * belongs to their own business, by name, and persists that choice in
 * `meta_capi_configs`.
 */
export async function discoverSharedAssets(
  creds: MetaCapiPlatformCredentials,
): Promise<DiscoverAssetsOutcome> {
  const [pixelsResult, wabaResult] = await Promise.all([
    fetchAssetList(creds.businessId, 'client_pixels', creds.systemUserToken),
    fetchAssetList(creds.businessId, 'client_whatsapp_business_accounts', creds.systemUserToken),
  ])
  if (!pixelsResult.ok) return { ok: false, error: pixelsResult.error }
  if (!wabaResult.ok) return { ok: false, error: wabaResult.error }
  return { ok: true, pixels: pixelsResult.assets, whatsappBusinessAccounts: wabaResult.assets }
}
