import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  switchSessionTo: vi.fn(),
  db: null as unknown,
  cookieSet: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/auth/login-as-session', () => ({ switchSessionTo: h.switchSessionTo }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.cookieSet }) }))

import { POST } from './route'
import { verifyReturnToken, RETURN_COOKIE, FLAG_COOKIE } from '@/lib/auth/login-as'

function fakeDb(
  opts: {
    account?: { id: string; name: string } | null
    members?: { user_id: string; account_role: string }[]
    emails?: Record<string, string | undefined>
  } = {},
) {
  const inserts: { table: string; row: unknown }[] = []
  const account = opts.account === undefined ? { id: 'acc-1', name: 'Concórdia' } : opts.account
  const members = opts.members ?? [{ user_id: 'owner-1', account_role: 'owner' }]
  const emails = opts.emails ?? { 'admin-1': 'admin@zontalk.shop', 'owner-1': 'dono@concordia.com' }
  return {
    inserts,
    db: {
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: table === 'accounts' ? account : null, error: null }),
          insert: (row: unknown) => {
            inserts.push({ table, row })
            return Promise.resolve({ error: null })
          },
          then: (resolve: (v: unknown) => void) => resolve({ data: table === 'profiles' ? members : null, error: null }),
        }
        return chain
      },
      auth: {
        admin: {
          getUserById: async (id: string) => ({ data: { user: emails[id] ? { email: emails[id] } : null } }),
        },
      },
    },
  }
}

const call = () => POST(new Request('http://localhost'), { params: Promise.resolve({ accountId: 'acc-1' }) })
let seq = 0

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  // Unique per test so the in-memory rate limiter never interferes.
  seq += 1
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1', __seq: seq })
  h.switchSessionTo.mockResolvedValue({ ok: true })
})

describe('POST /api/admin/accounts/[id]/impersonate', () => {
  it('propagates the platform-admin gate (403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    expect((await call()).status).toBe(403)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it('404s for an unknown account without swapping anything', async () => {
    h.db = fakeDb({ account: null }).db
    expect((await call()).status).toBe(404)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it('409s when the company has nobody to sign in as (agents only)', async () => {
    h.db = fakeDb({ members: [{ user_id: 'a', account_role: 'agent' }] }).db
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'no_admin_user' })
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it("signs in as the company's OWNER and stores a signed return ticket for the admin", async () => {
    const { db, inserts } = fakeDb()
    h.db = db
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, swapped: true, account: { id: 'acc-1', name: 'Concórdia' } })
    expect(h.switchSessionTo).toHaveBeenCalledWith('dono@concordia.com')

    const ticketCall = h.cookieSet.mock.calls.find((c) => c[0] === RETURN_COOKIE)!
    const ticket = verifyReturnToken(ticketCall[1], process.env.ENCRYPTION_KEY!)
    expect(ticket).toMatchObject({
      adminUserId: 'admin-1',
      adminEmail: 'admin@zontalk.shop',
      targetUserId: 'owner-1',
      accountId: 'acc-1',
    })
    expect(ticket!.lastActiveAt).toBeGreaterThan(0)
    expect(ticket!.exp).toBeGreaterThan(ticket!.lastActiveAt)
    expect(ticketCall[2]).toMatchObject({ httpOnly: true, secure: true })
    expect(h.cookieSet.mock.calls.find((c) => c[0] === FLAG_COOKIE)![2]).toMatchObject({ httpOnly: false })

    expect(inserts).toEqual([
      {
        table: 'admin_login_as_log',
        row: { admin_user_id: 'admin-1', target_user_id: 'owner-1', target_account_id: 'acc-1' },
      },
    ])
  })

  it('clears the return ticket again when the swap fails (the admin stays logged in as themselves)', async () => {
    const { db, inserts } = fakeDb()
    h.db = db
    h.switchSessionTo.mockResolvedValue({ ok: false, error: 'verifyOtp: nope' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call()
    expect(res.status).toBe(502)
    expect(h.cookieSet).toHaveBeenLastCalledWith(FLAG_COOKIE, '', { path: '/', maxAge: 0 })
    expect(h.cookieSet).toHaveBeenCalledWith(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
    expect(inserts).toHaveLength(0) // nothing is logged as a visit that never happened
    spy.mockRestore()
  })

  it('does nothing when the admin already is that company owner', async () => {
    h.db = fakeDb({ members: [{ user_id: 'admin-1', account_role: 'owner' }] }).db
    const res = await call()
    expect(await res.json()).toMatchObject({ success: true, swapped: false })
    expect(h.switchSessionTo).not.toHaveBeenCalled()
    expect(h.cookieSet).not.toHaveBeenCalled()
  })

  it('refuses to start without a signing secret', async () => {
    delete process.env.ENCRYPTION_KEY
    h.db = fakeDb().db
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await call()).status).toBe(500)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
