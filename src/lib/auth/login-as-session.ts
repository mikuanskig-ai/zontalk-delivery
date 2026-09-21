import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Replaces the browser's Supabase session with a session of the user
 * that owns `email` — a genuine login, no password or e-mail involved:
 * the service role mints a one-time login token (`generateLink`, which
 * sends nothing) and the SSR client redeems it, which writes the new
 * session cookies onto the response.
 *
 * On any failure the existing session cookies are left exactly as they
 * were, so a failed swap can never lock the admin out of their own
 * session. Server-only.
 */
export async function switchSessionTo(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    return { ok: false, error: `generateLink: ${error?.message ?? 'no token returned'}` }
  }

  const supabase = await createClient()
  // GoTrue accepts the token under either name depending on version;
  // a wrong-type attempt doesn't consume the token, so try both.
  let lastError = ''
  for (const type of ['magiclink', 'email'] as const) {
    const { data: verified, error: vErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!vErr && verified.session) return { ok: true }
    lastError = vErr?.message ?? 'no session returned'
  }
  return { ok: false, error: `verifyOtp: ${lastError}` }
}
