import { createHmac, timingSafeEqual } from 'node:crypto'

// "Acessar empresa" as a REAL login (Eder, 2026-09-21). The platform
// admin's browser session is swapped for a session of the company's own
// admin (its owner), so every page, permission and record attribution is
// exactly that user's — instead of the admin staying logged in as
// themselves with a grant (migration 080, retired by migration 085).
//
// Getting back: the admin's identity is kept in a SIGNED, httpOnly
// cookie. "Sair" verifies the signature, re-checks the admin is still a
// platform admin, and swaps the session back. The value is never trusted
// unsigned, so nobody can forge their way into an admin session.

/** httpOnly, signed — proves who to return to. */
export const RETURN_COOKIE = 'zdelivery_admin_return'
/** Readable by the browser (just "1") so the banner knows to show. Carries no authority. */
export const FLAG_COOKIE = 'zdelivery_imp'
/** How long the "return to admin" ticket lives. */
export const RETURN_MAX_AGE_SECONDS = 8 * 60 * 60

export interface ReturnPayload {
  adminUserId: string
  adminEmail: string
  targetUserId: string
  accountId: string
  /** epoch ms */
  exp: number
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

export function signReturnToken(payload: ReturnPayload, secret: string): string {
  if (!secret) throw new Error('missing signing secret')
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `${body}.${sign(body, secret)}`
}

/** `null` for anything malformed, tampered with, or expired. */
export function verifyReturnToken(token: string | undefined, secret: string, now: number = Date.now()): ReturnPayload | null {
  if (!token || !secret) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = sign(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ReturnPayload
    if (
      typeof payload.adminUserId !== 'string' ||
      typeof payload.adminEmail !== 'string' ||
      typeof payload.targetUserId !== 'string' ||
      typeof payload.accountId !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null
    }
    return payload.exp > now ? payload : null
  } catch {
    return null
  }
}

interface MemberRow {
  user_id: string
  account_role: string
}

/** Pure — the company's admin account: its owner, else an admin. `null` if neither exists. */
export function pickTargetMember(members: MemberRow[]): string | null {
  const owner = members.find((m) => m.account_role === 'owner')
  if (owner) return owner.user_id
  const admin = members.find((m) => m.account_role === 'admin')
  return admin?.user_id ?? null
}
