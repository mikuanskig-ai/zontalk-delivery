import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  FLAG_COOKIE,
  RETURN_COOKIE,
  RETURN_MAX_AGE_SECONDS,
  isAutoExitDue,
  renewTicket,
  signReturnToken,
  verifyReturnToken,
} from '@/lib/auth/login-as'

// node:crypto (used to verify/re-sign the return-ticket cookie below)
// needs the Node middleware runtime, not the default edge one.
export const runtime = 'nodejs'

export async function middleware(request: NextRequest) {
  // "Acessar empresa" auto-timeout, IDLE-based (Eder, 2026-09-22, fixed
  // again 2026-09-23): checked on every plain page navigation (not API
  // calls, so an in-flight fetch never gets redirected instead of its
  // expected JSON). A missing/expired ticket, or one idle past
  // AUTO_EXIT_AFTER_MS, sends the browser to the exit route, which
  // swaps the session back to the admin. Otherwise the ticket's
  // `lastActiveAt` is renewed right here (carried onto whatever
  // response this request ends up returning, below) — a v1 that
  // measured from the VISIT START instead of last activity cut an
  // admin's genuinely active session off mid-task at the 30-minute
  // mark, which is exactly the "desloga sozinho" complaint this exists
  // to prevent, not cause.
  let renewedTicketCookie: string | null = null
  if (
    request.method === 'GET' &&
    !request.nextUrl.pathname.startsWith('/api/') &&
    !request.nextUrl.pathname.startsWith('/_next/') &&
    request.cookies.get(FLAG_COOKIE)?.value === '1'
  ) {
    const secret = process.env.ENCRYPTION_KEY ?? ''
    const ticket = verifyReturnToken(request.cookies.get(RETURN_COOKIE)?.value, secret)
    if (!ticket || isAutoExitDue(ticket)) {
      const url = request.nextUrl.clone()
      const next = encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)
      url.pathname = '/api/admin/impersonate/exit'
      url.search = `?next=${next}`
      return NextResponse.redirect(url)
    }
    renewedTicketCookie = signReturnToken(renewTicket(ticket), secret)
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    if (renewedTicketCookie) {
      response.cookies.set(RETURN_COOKIE, renewedTicketCookie, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: RETURN_MAX_AGE_SECONDS,
      })
    }
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Root page — an already-authenticated visitor goes straight into the
  // app instead of seeing the marketing landing again. An anonymous
  // visitor gets NO redirect here (unlike protectedPaths below, there is
  // no "logged out ⇒ redirect" rule for `/`) — the request just falls
  // through and src/app/page.tsx renders the landing page directly.
  if (user && request.nextUrl.pathname === '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings', '/delivery', '/admin']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks or cron endpoints — both
  // are hit without a browser session and carry their own auth: a
  // per-request signature/verify-token for webhooks, the shared
  // `x-cron-secret` header for cron routes).
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook') &&
      !request.nextUrl.pathname.endsWith('/cron')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return withRefreshedCookies(supabaseResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
