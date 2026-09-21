import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  switchSessionTo: vi.fn(),
  getUser: vi.fn(),
  db: null as unknown,
  jar: new Map<string, string>(),
  cookieSet: vi.fn(),
}))

vi.mock('@/lib/auth/login-as-session', () => ({ switchSessionTo: h.switchSessionTo }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: h.getUser } }) }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: h.cookieSet,
  }),
}))

import { POST } from './route'
import { signReturnToken, RETURN_COOKIE, FLAG_COOKIE } from '@/lib/auth/login-as'

const SECRET = 'b'.repeat(64)

function fakeDb(opts: { isPlatformAdmin?: boolean; adminEmail?: string | null } = {}) {
  const updates: { table: string; payload: unknown }[] = []
  return {
    updates,
    db: {
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          update: (payload: unknown) => {
            updates.push({ table, payload })
            return chain
          },
          eq: () => chain,
          is: () => Promise.resolve({ error: null }),
          maybeSingle: () => Promise.resolve({ data: { is_platform_admin: opts.isPlatformAdmin ?? true }, error: null }),
        }
        return chain
      },
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: opts.adminEmail === null ? null : { email: opts.adminEmail ?? 'admin@zontalk.shop' } },
          }),
        },
      },
    },
  }
}

const validTicket = (over: Record<string, unknown> = {}) =>
  signReturnToken(
    {
      adminUserId: 'admin-1',
      adminEmail: 'admin@zontalk.shop',
      targetUserId: 'owner-1',
      accountId: 'acc-1',
      exp: Date.now() + 60_000,
      ...over,
    },
    SECRET,
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.jar = new Map()
  process.env.ENCRYPTION_KEY = SECRET
  h.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
  h.switchSessionTo.mockResolvedValue({ ok: true })
})

describe('POST /api/admin/impersonate/exit', () => {
  it('401s and clears the cookies when there is no valid return ticket', async () => {
    h.db = fakeDb().db
    const res = await POST()
    expect(res.status).toBe(401)
    expect(h.cookieSet).toHaveBeenCalledWith(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it('rejects a forged ticket (bad signature) with no session swap', async () => {
    h.db = fakeDb().db
    h.jar.set(
      RETURN_COOKIE,
      signReturnToken(
        { adminUserId: 'admin-1', adminEmail: 'x', targetUserId: 'owner-1', accountId: 'acc-1', exp: Date.now() + 60_000 },
        'wrong-secret',
      ),
    )
    expect((await POST()).status).toBe(401)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it('403s when the current session is not the user the ticket was issued for', async () => {
    h.db = fakeDb().db
    h.jar.set(RETURN_COOKIE, validTicket())
    h.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } } })
    expect((await POST()).status).toBe(403)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
  })

  it('403s and clears when the ticket holder is no longer a platform admin', async () => {
    h.db = fakeDb({ isPlatformAdmin: false }).db
    h.jar.set(RETURN_COOKIE, validTicket())
    const res = await POST()
    expect(res.status).toBe(403)
    expect(h.switchSessionTo).not.toHaveBeenCalled()
    expect(h.cookieSet).toHaveBeenCalledWith(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
  })

  it('swaps the session back to the admin, clears both cookies and closes the audit row', async () => {
    const { db, updates } = fakeDb()
    h.db = db
    h.jar.set(RETURN_COOKIE, validTicket())
    const res = await POST()
    expect(res.status).toBe(200)
    expect(h.switchSessionTo).toHaveBeenCalledWith('admin@zontalk.shop')
    expect(h.cookieSet).toHaveBeenCalledWith(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
    expect(h.cookieSet).toHaveBeenCalledWith(FLAG_COOKIE, '', { path: '/', maxAge: 0 })
    expect(updates.find((u) => u.table === 'admin_login_as_log')?.payload).toMatchObject({
      ended_at: expect.any(String),
    })
  })

  it('keeps the cookies (so the admin can retry) when the swap fails', async () => {
    h.db = fakeDb().db
    h.jar.set(RETURN_COOKIE, validTicket())
    h.switchSessionTo.mockResolvedValue({ ok: false, error: 'boom' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST()
    expect(res.status).toBe(502)
    expect(h.cookieSet).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
