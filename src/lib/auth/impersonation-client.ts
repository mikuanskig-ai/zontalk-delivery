import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Browser-safe counterpart to `findActiveImpersonation` in
// src/lib/auth/account.ts (server-only, imports next/headers). Same
// query, same migration-080 grant table, same "best-effort, never
// blocks the caller's own account" contract — kept as a separate
// module (not shared code) purely because the server file can't be
// imported from a client component.
//
// Callers gate this behind `is_platform_admin` themselves (the
// SELECT policy already scopes rows to `admin_user_id = auth.uid()`,
// but the extra round trip is only ever worth paying for an actual
// platform admin — see use-auth.tsx and upload-media.ts).
// ============================================================

export interface ActiveImpersonation {
  accountId: string;
  role: string;
}

export async function findActiveImpersonationClient(
  supabase: SupabaseClient,
  adminUserId: string,
): Promise<ActiveImpersonation | null> {
  try {
    const { data, error } = await supabase
      .from("admin_impersonation_sessions")
      .select("target_account_id, target_role")
      .eq("admin_user_id", adminUserId)
      .is("ended_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return { accountId: data.target_account_id as string, role: data.target_role as string };
  } catch {
    return null;
  }
}
