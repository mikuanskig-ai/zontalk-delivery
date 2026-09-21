import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  FLAG_COOKIE,
  RETURN_COOKIE,
  RETURN_MAX_AGE_SECONDS,
  pickTargetMember,
  signReturnToken,
} from '@/lib/auth/login-as'
import { switchSessionTo } from '@/lib/auth/login-as-session'

/**
 * POST /api/admin/accounts/[accountId]/impersonate  (platform admin only)
 *
 * "Acessar Empresa" — logs the platform admin in AS the company's own
 * admin (its owner; an admin-role member if there is no owner). From the
 * next request on, the session IS that user: their name, permissions and
 * data, and everything the admin does is attributed to them.
 *
 * Before swapping, a signed httpOnly cookie records who to return to
 * (see login-as.ts), and the start is written to admin_login_as_log
 * (migration 085) — this is the audit trail, since inside the account
 * the admin is indistinguishable from the real user.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { userId } = await requirePlatformAdmin()
    const { accountId } = await params

    const limit = checkRateLimit(`admin-impersonate-start:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const secret = process.env.ENCRYPTION_KEY
    if (!secret) {
      console.error('[admin/impersonate POST] ENCRYPTION_KEY is not set — cannot sign the return ticket')
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }

    const admin = supabaseAdmin()

    const { data: account, error: accountErr } = await admin
      .from('accounts')
      .select('id, name')
      .eq('id', accountId)
      .maybeSingle()
    if (accountErr) {
      console.error('[admin/impersonate POST] account fetch error:', accountErr)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!account) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const { data: members, error: membersErr } = await admin
      .from('profiles')
      .select('user_id, account_role')
      .eq('account_id', accountId)
    if (membersErr) {
      console.error('[admin/impersonate POST] members fetch error:', membersErr)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    const targetUserId = pickTargetMember((members ?? []) as { user_id: string; account_role: string }[])
    if (!targetUserId) {
      return NextResponse.json({ error: 'no_admin_user' }, { status: 409 })
    }
    if (targetUserId === userId) {
      // Already this company's own admin — nothing to swap.
      return NextResponse.json({ success: true, account: { id: account.id, name: account.name }, swapped: false })
    }

    const [{ data: adminAuth }, { data: targetAuth }] = await Promise.all([
      admin.auth.admin.getUserById(userId),
      admin.auth.admin.getUserById(targetUserId),
    ])
    const adminEmail = adminAuth?.user?.email
    const targetEmail = targetAuth?.user?.email
    if (!adminEmail || !targetEmail) {
      return NextResponse.json({ error: 'no_admin_user' }, { status: 409 })
    }

    // The return ticket goes on the response BEFORE the session swap: if
    // anything after the swap went wrong, the admin would otherwise be
    // stuck logged in as the company's user with no way back. A failed
    // swap clears it again.
    const jar = await cookies()
    jar.set(
      RETURN_COOKIE,
      signReturnToken(
        {
          adminUserId: userId,
          adminEmail,
          targetUserId,
          accountId,
          exp: Date.now() + RETURN_MAX_AGE_SECONDS * 1000,
        },
        secret,
      ),
      { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: RETURN_MAX_AGE_SECONDS },
    )
    jar.set(FLAG_COOKIE, '1', { httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: RETURN_MAX_AGE_SECONDS })

    const swapped = await switchSessionTo(targetEmail)
    if (!swapped.ok) {
      console.error('[admin/impersonate POST] session swap failed:', swapped.error)
      jar.set(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
      jar.set(FLAG_COOKIE, '', { path: '/', maxAge: 0 })
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 502 })
    }

    const { error: logErr } = await admin.from('admin_login_as_log').insert({
      admin_user_id: userId,
      target_user_id: targetUserId,
      target_account_id: accountId,
    })
    if (logErr) console.error('[admin/impersonate POST] audit log insert failed:', logErr)

    return NextResponse.json({ success: true, account: { id: account.id, name: account.name }, swapped: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
