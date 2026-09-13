import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  db: null as unknown,
  cookieSet: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.cookieSet }) }))

/** Table-keyed fake — `.maybeSingle()` resolves the account lookup,
 *  `.then()` resolves the update (end-previous) / insert (new grant)
 *  writes, mirroring the two Supabase call shapes the route actually
 *  uses. */
function fakeDb(opts: {
  account?: { data: unknown; error: unknown };
  endError?: unknown;
  insertError?: unknown;
}) {
  const calls: { table: string; op: string }[] = []
  return {
    calls,
    db: {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: () => {
            calls.push({ table, op: 'maybeSingle' })
            return Promise.resolve(opts.account ?? { data: null, error: null })
          },
          update: () => {
            calls.push({ table, op: 'update' })
            return chain
          },
          insert: () => {
            calls.push({ table, op: 'insert' })
            return Promise.resolve({ error: opts.insertError ?? null })
          },
          then: (resolve: (v: { error: unknown }) => void) => {
            // Reached only by the `.update(...).eq().is()` chain (no insert()/maybeSingle() called on it).
            return resolve({ error: opts.endError ?? null })
          },
        }
        return chain
      },
    },
  }
}

import { POST } from './route'

function req() {
  return new Request('http://localhost/api/admin/accounts/acct-1/impersonate', { method: 'POST' })
}
const params = { params: Promise.resolve({ accountId: 'acct-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' })
})

describe('POST /api/admin/accounts/[accountId]/impersonate', () => {
  it('propagates the platform-admin gate (403) when the caller is not a platform admin', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    const res = await POST(req(), params)
    expect(res.status).toBe(403)
  })

  it('404s when the target account does not exist', async () => {
    const { db } = fakeDb({ account: { data: null, error: null } })
    h.db = db
    const res = await POST(req(), params)
    expect(res.status).toBe(404)
  })

  it('ends any previous active grant, inserts the new one, sets the fast-path cookie, and returns the account', async () => {
    const { db, calls } = fakeDb({ account: { data: { id: 'acct-1', name: 'Empresa Alvo' }, error: null } })
    h.db = db
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, account: { id: 'acct-1', name: 'Empresa Alvo' } })

    expect(calls.map((c) => c.op)).toEqual(['maybeSingle', 'update', 'insert'])
    expect(h.cookieSet).toHaveBeenCalledWith(
      'zdelivery_impersonating',
      '1',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    )
  });

  it('surfaces a 500 when the insert fails, without pretending it succeeded', async () => {
    const { db } = fakeDb({
      account: { data: { id: 'acct-1', name: 'Empresa Alvo' }, error: null },
      insertError: { message: 'boom' },
    })
    h.db = db
    const res = await POST(req(), params)
    expect(res.status).toBe(500)
    expect(h.cookieSet).not.toHaveBeenCalled()
  })
})
