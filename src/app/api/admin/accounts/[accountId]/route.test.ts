import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ requirePlatformAdmin: vi.fn(), db: null as unknown }))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))

import { DELETE } from './route'

function fakeDb(opts: { account?: { id: string; name: string } | null; ownerEmail?: string | null; logError?: unknown; deleteError?: unknown } = {}) {
  const account = opts.account === undefined ? { id: 'acc-1', name: 'Concórdia' } : opts.account
  const inserts: { table: string; row: unknown }[] = []
  const deletes: { table: string; id: string }[] = []
  return {
    inserts,
    deletes,
    db: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: table === 'profiles' ? (opts.ownerEmail === undefined ? { email: 'dono@concordia.com' } : opts.ownerEmail ? { email: opts.ownerEmail } : null) : null, error: null }) }),
            maybeSingle: () => Promise.resolve({ data: table === 'accounts' ? account : null, error: table === 'accounts' && opts.account === null ? null : null }),
          }),
        }),
        insert: (row: unknown) => {
          inserts.push({ table, row })
          return Promise.resolve({ error: opts.logError ?? null })
        },
        delete: () => ({
          eq: (col: string, id: string) => {
            deletes.push({ table, id })
            return Promise.resolve({ error: opts.deleteError ?? null })
          },
        }),
      }),
    },
  }
}

let seq = 0
function asAdmin() {
  h.requirePlatformAdmin.mockResolvedValue({ userId: `admin-${++seq}` })
}

const call = (body: unknown) =>
  DELETE(
    new Request('http://localhost', { method: 'DELETE', body: JSON.stringify(body) }),
    { params: Promise.resolve({ accountId: 'acc-1' }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  asAdmin()
})

describe('DELETE /api/admin/accounts/[id]', () => {
  it('propagates the platform-admin gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    h.db = fakeDb().db
    expect((await call({ confirm_name: 'Concórdia' })).status).toBe(403)
  })

  it('400s when confirm_name is missing', async () => {
    h.db = fakeDb().db
    const res = await call({})
    expect(res.status).toBe(400)
  })

  it('400s when confirm_name does not match the account name — no delete, no log', async () => {
    const { db, deletes, inserts } = fakeDb()
    h.db = db
    const res = await call({ confirm_name: 'wrong name' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'name_mismatch' })
    expect(deletes).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it('404s for an unknown account', async () => {
    h.db = fakeDb({ account: null }).db
    const res = await call({ confirm_name: 'anything' })
    expect(res.status).toBe(404)
  })

  it('logs the deletion BEFORE deleting, then deletes the account', async () => {
    const { db, inserts, deletes } = fakeDb()
    h.db = db
    const res = await call({ confirm_name: 'Concórdia' })
    expect(res.status).toBe(200)
    expect(inserts).toEqual([
      {
        table: 'admin_account_deletion_log',
        row: expect.objectContaining({
          deleted_account_id: 'acc-1',
          account_name: 'Concórdia',
          owner_email: 'dono@concordia.com',
        }),
      },
    ])
    expect(deletes).toEqual([{ table: 'accounts', id: 'acc-1' }])
  })

  it('refuses to delete when the audit log insert fails — no account loss without a trail', async () => {
    const { db, deletes } = fakeDb({ logError: new Error('db down') })
    h.db = db
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call({ confirm_name: 'Concórdia' })
    expect(res.status).toBe(500)
    expect(deletes).toHaveLength(0)
    spy.mockRestore()
  })

  it('surfaces a 500 if the delete itself fails after logging', async () => {
    const { db } = fakeDb({ deleteError: new Error('fk violation') })
    h.db = db
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call({ confirm_name: 'Concórdia' })
    expect(res.status).toBe(500)
    spy.mockRestore()
  })
})
