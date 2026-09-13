import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse, IMPERSONATION_COOKIE } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * POST /api/admin/impersonate/exit  (platform admin only)
 *
 * Ends the caller's own active "Acessar Empresa" grant (migration 080)
 * and clears the fast-path cookie — the next request resolves back to
 * the admin's own account via the normal profile lookup.
 *
 * `requirePlatformAdmin` reads the admin's OWN profiles row by
 * `user_id`, which is untouched by impersonation (only
 * `getCurrentAccount`/`requireRole` — the tenant-scoped path — honor
 * the grant), so this correctly identifies the real admin even while
 * they're mid-impersonation.
 */
export async function POST() {
  try {
    const { userId } = await requirePlatformAdmin()

    const admin = supabaseAdmin()
    const { error } = await admin
      .from('admin_impersonation_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('admin_user_id', userId)
      .is('ended_at', null)
    if (error) {
      console.error('[admin/impersonate/exit POST] update error:', error)
      return NextResponse.json({ error: 'Failed to exit impersonation' }, { status: 500 })
    }

    const jar = await cookies()
    jar.set(IMPERSONATION_COOKIE, '', { path: '/', maxAge: 0 })

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
