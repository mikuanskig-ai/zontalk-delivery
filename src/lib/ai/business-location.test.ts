import { describe, expect, it } from 'vitest'
import { formatBusinessLocation } from './business-location'

describe('formatBusinessLocation', () => {
  it('builds a coordinates-based Maps link when lat/lng are known (numeric strings from PostgREST too)', () => {
    expect(
      formatBusinessLocation({
        origin_address: 'Rua Presidente Kennedy 2237, Centro, Cascavel - PR, 85810-041',
        origin_lat: '-24.949824',
        origin_lng: -53.479192,
      }),
    ).toEqual({
      address: 'Rua Presidente Kennedy 2237, Centro, Cascavel - PR, 85810-041',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=-24.949824,-53.479192',
    })
  })

  it('falls back to an address-text query when there are no coordinates', () => {
    const loc = formatBusinessLocation({ origin_address: 'Rua A 10, Centro', origin_lat: null, origin_lng: null })
    expect(loc?.mapsUrl).toBe('https://www.google.com/maps/search/?api=1&query=Rua%20A%2010%2C%20Centro')
  })

  it('returns null with no row or a blank address', () => {
    expect(formatBusinessLocation(null)).toBeNull()
    expect(formatBusinessLocation({ origin_address: '   ', origin_lat: 1, origin_lng: 2 })).toBeNull()
    expect(formatBusinessLocation({ origin_address: null, origin_lat: 1, origin_lng: 2 })).toBeNull()
  })
})
