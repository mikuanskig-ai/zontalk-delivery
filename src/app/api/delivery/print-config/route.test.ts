import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((err: unknown) => Response.json({ error: String(err) }, { status: 500 })),
}))

import { GET, POST } from './route'

function makeDb(opts: { existing?: { enabled: boolean; compact_print: boolean } | null } = {}) {
  const existing = 'existing' in opts ? opts.existing : { enabled: false, compact_print: false }
  const updates: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: existing ? { id: 'cfg-1', ...existing } : null,
              error: null,
            }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push(payload)
        return Promise.resolve({ error: null })
      },
    }),
  } as unknown as SupabaseClient
  return { db, updates, inserts }
}

function request(body: unknown) {
  return new Request('http://localhost/api/delivery/print-config', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.getCurrentAccount.mockReset()
})

describe('GET /api/delivery/print-config', () => {
  it('includes compact_print alongside enabled/last_polled_at', async () => {
    const { db } = makeDb({ existing: { enabled: true, compact_print: true } })
    mocks.getCurrentAccount.mockResolvedValue({ supabase: db, accountId: 'acct-1' })
    const res = await GET()
    const data = await res.json()
    expect(data).toMatchObject({ configured: true, enabled: true, compact_print: true })
  })
})

describe('POST /api/delivery/print-config', () => {
  it('toggling compact_print does NOT reset enabled back to false — regression, 2026-09-07', async () => {
    // The two settings are independent UI toggles that both POST to
    // this same route — flipping one must never silently reset the
    // other back to whatever an absent field defaults to.
    const { db, updates } = makeDb({ existing: { enabled: true, compact_print: false } })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(request({ compact_print: true }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.enabled).toBe(true) // untouched, read back from the existing row
    expect(data.compact_print).toBe(true)
    expect(updates).toEqual([{ compact_print: true }]) // enabled never included in the patch
  })

  it('toggling enabled does NOT reset compact_print back to false', async () => {
    const { db, updates } = makeDb({ existing: { enabled: false, compact_print: true } })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    const res = await POST(request({ enabled: true }))
    const data = await res.json()

    expect(data.enabled).toBe(true)
    expect(data.compact_print).toBe(true) // untouched
    expect(updates).toEqual([{ enabled: true }])
  })

  it('sets both fields in one call when both are sent', async () => {
    const { db, updates } = makeDb({ existing: { enabled: false, compact_print: false } })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    await POST(request({ enabled: true, compact_print: true }))
    expect(updates).toEqual([{ enabled: true, compact_print: true }])
  })

  it('inserts a new row with schema defaults for the field not sent, on first save', async () => {
    const { db, inserts } = makeDb({ existing: null })
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })

    await POST(request({ enabled: true }))
    expect(inserts).toEqual([{ account_id: 'acct-1', enabled: true, compact_print: false }])
  })

  it('rejects a body with neither field', async () => {
    const { db } = makeDb()
    mocks.requireRole.mockResolvedValue({ supabase: db, accountId: 'acct-1', userId: 'user-1' })
    const res = await POST(request({}))
    expect(res.status).toBe(400)
  })
})
