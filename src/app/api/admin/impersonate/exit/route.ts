import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { FLAG_COOKIE, RETURN_COOKIE, verifyReturnToken } from '@/lib/auth/login-as'
import { switchSessionTo } from '@/lib/auth/login-as-session'

/**
 * POST /api/admin/impersonate/exit
 *
 * Leaves "Acessar Empresa": swaps the session back to the platform
 * admin who started it. NOT gated by `requirePlatformAdmin` — while
 * impersonating, the caller's session is the company's own user. The
 * authority comes from the signed httpOnly return cookie instead
 * (login-as.ts), plus three re-checks: the ticket is unexpired, the
 * current session really is the user it was issued for, and the admin
 * is still a platform admin.
 *
 * On a failed swap the cookies are KEPT so the admin can simply retry
 * (worst case: sign out and in with their own password).
 */
export async function POST() {
  const jar = await cookies()
  const clear = () => {
    jar.set(RETURN_COOKIE, '', { path: '/', maxAge: 0 })
    jar.set(FLAG_COOKIE, '', { path: '/', maxAge: 0 })
  }

  try {
    const secret = process.env.ENCRYPTION_KEY ?? ''
    const ticket = verifyReturnToken(jar.get(RETURN_COOKIE)?.value, secret)
    if (!ticket) {
      clear()
      return NextResponse.json({ error: 'no_return_ticket' }, { status: 401 })
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user || user.id !== ticket.targetUserId) {
      return NextResponse.json({ error: 'session_mismatch' }, { status: 403 })
    }

    const admin = supabaseAdmin()
    const [{ data: profile }, { data: adminAuth }] = await Promise.all([
      admin.from('profiles').select('is_platform_admin').eq('user_id', ticket.adminUserId).maybeSingle(),
      admin.auth.admin.getUserById(ticket.adminUserId),
    ])
    const adminEmail = adminAuth?.user?.email
    if (!profile?.is_platform_admin || !adminEmail) {
      clear()
      return NextResponse.json({ error: 'not_platform_admin' }, { status: 403 })
    }

    const swapped = await switchSessionTo(adminEmail)
    if (!swapped.ok) {
      console.error('[admin/impersonate/exit POST] session swap failed:', swapped.error)
      return NextResponse.json({ error: 'Failed to exit impersonation' }, { status: 502 })
    }

    clear()
    const { error: logErr } = await admin
      .from('admin_login_as_log')
      .update({ ended_at: new Date().toISOString() })
      .eq('admin_user_id', ticket.adminUserId)
      .eq('target_account_id', ticket.accountId)
      .is('ended_at', null)
    if (logErr) console.error('[admin/impersonate/exit POST] audit log update failed:', logErr)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin/impersonate/exit POST] unexpected error:', err)
    return NextResponse.json({ error: 'Failed to exit impersonation' }, { status: 500 })
  }
}
