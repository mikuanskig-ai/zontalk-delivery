import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { FLAG_COOKIE, RETURN_COOKIE, verifyReturnToken } from '@/lib/auth/login-as'
import { switchSessionTo } from '@/lib/auth/login-as-session'

type ExitResult =
  | { ok: true }
  | { ok: false; error: 'no_return_ticket' | 'session_mismatch' | 'not_platform_admin' | 'swap_failed' | 'unexpected' }

/**
 * Shared by both exit paths: the explicit "Voltar para o meu usuário"
 * click (POST) and the automatic timeout the middleware redirects into
 * (GET, see AUTO_EXIT_AFTER_MS in login-as.ts). NOT gated by
 * `requirePlatformAdmin` — while impersonating, the caller's session is
 * the company's own user. The authority comes from the signed httpOnly
 * return cookie instead (login-as.ts), plus three re-checks: the
 * ticket is unexpired, the current session really is the user it was
 * issued for, and the admin is still a platform admin.
 *
 * On a failed swap the cookies are KEPT so the admin can simply retry
 * (worst case: sign out and in with their own password).
 */
async function performExit(): Promise<ExitResult> {
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
      return { ok: false, error: 'no_return_ticket' }
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user || user.id !== ticket.targetUserId) {
      return { ok: false, error: 'session_mismatch' }
    }

    const admin = supabaseAdmin()
    const [{ data: profile }, { data: adminAuth }] = await Promise.all([
      admin.from('profiles').select('is_platform_admin').eq('user_id', ticket.adminUserId).maybeSingle(),
      admin.auth.admin.getUserById(ticket.adminUserId),
    ])
    const adminEmail = adminAuth?.user?.email
    if (!profile?.is_platform_admin || !adminEmail) {
      clear()
      return { ok: false, error: 'not_platform_admin' }
    }

    const swapped = await switchSessionTo(adminEmail)
    if (!swapped.ok) {
      console.error('[admin/impersonate/exit] session swap failed:', swapped.error)
      return { ok: false, error: 'swap_failed' }
    }

    clear()
    const { error: logErr } = await admin
      .from('admin_login_as_log')
      .update({ ended_at: new Date().toISOString() })
      .eq('admin_user_id', ticket.adminUserId)
      .eq('target_account_id', ticket.accountId)
      .is('ended_at', null)
    if (logErr) console.error('[admin/impersonate/exit] audit log update failed:', logErr)

    return { ok: true }
  } catch (err) {
    console.error('[admin/impersonate/exit] unexpected error:', err)
    return { ok: false, error: 'unexpected' }
  }
}

const STATUS_BY_ERROR: Record<Exclude<ExitResult, { ok: true }>['error'], number> = {
  no_return_ticket: 401,
  session_mismatch: 403,
  not_platform_admin: 403,
  swap_failed: 502,
  unexpected: 500,
}

/** POST /api/admin/impersonate/exit — the explicit "Voltar para o meu usuário" click. */
export async function POST() {
  const result = await performExit()
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error === 'swap_failed' ? 'Failed to exit impersonation' : result.error },
      { status: STATUS_BY_ERROR[result.error] },
    )
  }
  return NextResponse.json({ success: true })
}

/**
 * GET /api/admin/impersonate/exit — the automatic timeout path. The
 * middleware redirects here (a browser navigation, so it must be GET)
 * once AUTO_EXIT_AFTER_MS has passed since the visit started. Always
 * ends in a redirect, never JSON, since nothing is listening for a
 * fetch response on this path — `/admin` on success so the banner and
 * a toast can confirm what happened, `/login` if the ticket is
 * unrecoverable, and back to wherever the admin was otherwise (the
 * cookies are kept, matching the manual retry behavior above).
 */
export async function GET(request: Request) {
  const result = await performExit()
  const url = new URL(request.url)
  if (result.ok) {
    url.pathname = '/admin'
    url.search = '?auto_exit=1'
    return NextResponse.redirect(url)
  }
  if (result.error === 'no_return_ticket') {
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }
  // session_mismatch / swap_failed / unexpected / not_platform_admin —
  // let the request continue to wherever it was headed; the banner's
  // manual "Voltar" button is still there to retry.
  const next = url.searchParams.get('next')
  url.pathname = next && next.startsWith('/') ? next : '/dashboard'
  url.search = ''
  return NextResponse.redirect(url)
}
