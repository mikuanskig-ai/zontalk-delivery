import { describe, expect, it } from 'vitest'
import {
  AUTO_EXIT_AFTER_MS,
  isAutoExitDue,
  pickTargetMember,
  signReturnToken,
  verifyReturnToken,
  type ReturnPayload,
} from './login-as'

const SECRET = 'test-secret-value'
const NOW = 1_800_000_000_000
const payload = (over: Partial<ReturnPayload> = {}): ReturnPayload => ({
  adminUserId: 'admin-1',
  adminEmail: 'admin@zontalk.shop',
  targetUserId: 'owner-1',
  accountId: 'acc-1',
  startedAt: NOW,
  exp: NOW + 60_000,
  ...over,
})

describe('return ticket signing', () => {
  it('round-trips a valid ticket', () => {
    const token = signReturnToken(payload(), SECRET)
    expect(verifyReturnToken(token, SECRET, NOW)).toEqual(payload())
  })

  it('rejects an expired ticket', () => {
    const token = signReturnToken(payload({ exp: NOW - 1 }), SECRET)
    expect(verifyReturnToken(token, SECRET, NOW)).toBeNull()
  })

  it('rejects a ticket signed with a different secret', () => {
    expect(verifyReturnToken(signReturnToken(payload(), 'other-secret'), SECRET, NOW)).toBeNull()
  })

  it('rejects a tampered payload (cannot swap in another admin id)', () => {
    const token = signReturnToken(payload(), SECRET)
    const [, sig] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify(payload({ adminUserId: 'someone-else' }))).toString('base64url')
    expect(verifyReturnToken(`${forgedBody}.${sig}`, SECRET, NOW)).toBeNull()
  })

  it.each([undefined, '', 'garbage', 'a.b.c', '.', 'onlybody.'])('rejects malformed input %j', (bad) => {
    expect(verifyReturnToken(bad as string | undefined, SECRET, NOW)).toBeNull()
  })

  it('rejects a payload that is missing fields even with a wrong signature', () => {
    const body = Buffer.from(JSON.stringify({ adminUserId: 'a', exp: NOW + 1000 })).toString('base64url')
    expect(verifyReturnToken(`${body}.x`, SECRET, NOW)).toBeNull()
  })

  it('refuses to sign or verify without a secret', () => {
    expect(() => signReturnToken(payload(), '')).toThrow()
    expect(verifyReturnToken(signReturnToken(payload(), SECRET), '', NOW)).toBeNull()
  })

  it('rejects a payload missing startedAt (older ticket shape), even correctly signed', () => {
    const withoutStartedAt: Partial<ReturnPayload> = payload()
    delete withoutStartedAt.startedAt
    const token = signReturnToken(withoutStartedAt as ReturnPayload, SECRET)
    expect(verifyReturnToken(token, SECRET, NOW)).toBeNull()
  })
})

describe('isAutoExitDue', () => {
  it('is false right after the visit starts', () => {
    expect(isAutoExitDue({ startedAt: NOW }, NOW)).toBe(false)
  })

  it('is false just under the timeout', () => {
    expect(isAutoExitDue({ startedAt: NOW }, NOW + AUTO_EXIT_AFTER_MS - 1)).toBe(false)
  })

  it('is true once the timeout has fully elapsed', () => {
    expect(isAutoExitDue({ startedAt: NOW }, NOW + AUTO_EXIT_AFTER_MS)).toBe(true)
  })
})

describe('pickTargetMember', () => {
  it('prefers the owner', () => {
    expect(
      pickTargetMember([
        { user_id: 'a', account_role: 'agent' },
        { user_id: 'adm', account_role: 'admin' },
        { user_id: 'own', account_role: 'owner' },
      ]),
    ).toBe('own')
  })

  it('falls back to an admin when there is no owner', () => {
    expect(pickTargetMember([{ user_id: 'a', account_role: 'agent' }, { user_id: 'adm', account_role: 'admin' }])).toBe('adm')
  })

  it('returns null when nobody can be signed in as (agents only, or empty)', () => {
    expect(pickTargetMember([{ user_id: 'a', account_role: 'agent' }])).toBeNull()
    expect(pickTargetMember([])).toBeNull()
  })
})
