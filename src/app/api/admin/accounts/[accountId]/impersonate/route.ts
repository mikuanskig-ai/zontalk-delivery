import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse, IMPERSONATION_COOKIE, IMPERSONATION_SESSION_MINUTES } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/admin/accounts/[accountId]/impersonate  (platform admin only)
 *
 * "Acessar Empresa" — starts a migration-080 impersonation grant so the
 * next request `getCurrentAccount()`/`requireRole()` resolves for THIS
 * account instead of the admin's own, everywhere in the app (RLS honors
 * the grant via `is_account_member` with zero per-route changes — see
 * the migration's doc comment).
 *
 * Always full ('owner') access — this is a support tool standing in
 * for "log in as this tenant", not a partial-permissions experiment.
 * One active grant per admin: starting a new one ends any previous
 * one first, so an admin can't accumulate live grants across several
 * accounts by clicking around.
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

    // End any previous still-active grant for this admin before
    // starting the new one — never more than one live at a time.
    const { error: endErr } = await admin
      .from('admin_impersonation_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('admin_user_id', userId)
      .is('ended_at', null)
    if (endErr) {
      console.error('[admin/impersonate POST] end-previous error:', endErr)
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }

    const expiresAt = new Date(Date.now() + IMPERSONATION_SESSION_MINUTES * 60_000).toISOString()
    const { error: insErr } = await admin.from('admin_impersonation_sessions').insert({
      admin_user_id: userId,
      target_account_id: accountId,
      target_role: 'owner',
      expires_at: expiresAt,
    })
    if (insErr) {
      console.error('[admin/impersonate POST] insert error:', insErr)
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }

    const jar = await cookies()
    jar.set(IMPERSONATION_COOKIE, '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: IMPERSONATION_SESSION_MINUTES * 60,
    })

    return NextResponse.json({ success: true, account: { id: account.id, name: account.name } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
