import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessLocation {
  /** Full street address as configured for delivery-fee calculation. */
  address: string
  /** Google Maps link (coordinates when known, else the address text). */
  mapsUrl: string
}

interface FeeConfigRow {
  origin_address: string | null
  origin_lat: number | string | null
  origin_lng: number | string | null
}

/** Pure — exported for tests. `null` when there's no usable address. */
export function formatBusinessLocation(row: FeeConfigRow | null): BusinessLocation | null {
  const address = row?.origin_address?.trim()
  if (!address) return null
  const lat = row?.origin_lat == null ? NaN : Number(row.origin_lat)
  const lng = row?.origin_lng == null ? NaN : Number(row.origin_lng)
  const query = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : encodeURIComponent(address)
  return { address, mapsUrl: `https://www.google.com/maps/search/?api=1&query=${query}` }
}

/**
 * The establishment's own address, already configured for the delivery
 * fee calculator (`delivery_fee_configs.origin_*`). Reused so the AI can
 * answer "onde fica?" with the real address + a map link instead of
 * improvising — confirmed live 2026-09-21: with no address anywhere in
 * its context the model answered "Fica no Shopping Cidade, na Praça de
 * Alimentação" (vague, no street, no map). Best-effort: a failed read
 * just means no location block, never a failed reply.
 */
export async function getBusinessLocation(db: SupabaseClient, accountId: string): Promise<BusinessLocation | null> {
  try {
    const { data } = await db
      .from('delivery_fee_configs')
      .select('origin_address, origin_lat, origin_lng')
      .eq('account_id', accountId)
      .maybeSingle()
    return formatBusinessLocation((data as FeeConfigRow | null) ?? null)
  } catch (err) {
    console.error('[ai] getBusinessLocation failed:', err instanceof Error ? err.message : err)
    return null
  }
}
