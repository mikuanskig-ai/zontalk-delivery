import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ generateLink: vi.fn(), verifyOtp: vi.fn() }))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ auth: { admin: { generateLink: h.generateLink } } }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp: h.verifyOtp } }),
}))

import { switchSessionTo } from './login-as-session'

beforeEach(() => {
  vi.clearAllMocks()
  h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'tok-123' } }, error: null })
})

describe('switchSessionTo', () => {
  it('mints a magic-link token for the email and redeems it for a session', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null })
    expect(await switchSessionTo('dono@concordia.com')).toEqual({ ok: true })
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'dono@concordia.com' })
    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: 'tok-123', type: 'magiclink' })
  })

  it('retries with the "email" type when the server rejects "magiclink"', async () => {
    h.verifyOtp
      .mockResolvedValueOnce({ data: { session: null }, error: { message: 'Token has expired or is invalid' } })
      .mockResolvedValueOnce({ data: { session: { access_token: 'x' } }, error: null })
    expect(await switchSessionTo('dono@concordia.com')).toEqual({ ok: true })
    expect(h.verifyOtp.mock.calls.map((c) => c[0].type)).toEqual(['magiclink', 'email'])
  })

  it('fails (without a session) when neither type is accepted', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: null }, error: { message: 'invalid' } })
    const r = await switchSessionTo('dono@concordia.com')
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toContain('verifyOtp')
  })

  it('fails without ever trying to verify when no token could be generated', async () => {
    h.generateLink.mockResolvedValue({ data: null, error: { message: 'User not found' } })
    const r = await switchSessionTo('ghost@x.com')
    expect(r).toMatchObject({ ok: false })
    expect(h.verifyOtp).not.toHaveBeenCalled()
  })

  it('does not report success when verify returns no error but also no session', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: null }, error: null })
    expect(await switchSessionTo('dono@concordia.com')).toMatchObject({ ok: false })
  })
})
