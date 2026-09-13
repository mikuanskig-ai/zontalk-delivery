import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  db: null as unknown,
  cookieSet: vi.fn(),
}))

vi.mock('@/lib/auth/platform-admin', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.cookieSet }) }))

function fakeDb(updateError: unknown = null) {
  const eqArgs: [string, unknown][] = []
  return {
    eqArgs,
    db: {
      from: () => {
        const chain = {
          update: () => chain,
          eq: (col: string, val: unknown) => {
            eqArgs.push([col, val])
            return chain
          },
          is: () => Promise.resolve({ error: updateError }),
        }
        return chain
      },
    },
  }
}

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' })
})

describe('POST /api/admin/impersonate/exit', () => {
  it('propagates the platform-admin gate (403) when the caller is not a platform admin', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requirePlatformAdmin.mockRejectedValue(new ForbiddenError('Platform admin only'))
    const res = await POST()
    expect(res.status).toBe(403)
  })

  it("ends the caller's own active grant and clears the fast-path cookie", async () => {
    const { db, eqArgs } = fakeDb()
    h.db = db
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(eqArgs).toEqual([['admin_user_id', 'admin-1']])
    expect(h.cookieSet).toHaveBeenCalledWith('zdelivery_impersonating', '', { path: '/', maxAge: 0 })
  })

  it('surfaces a 500 when the update fails', async () => {
    const { db } = fakeDb({ message: 'boom' })
    h.db = db
    const res = await POST()
    expect(res.status).toBe(500)
    expect(h.cookieSet).not.toHaveBeenCalled()
  })
})
