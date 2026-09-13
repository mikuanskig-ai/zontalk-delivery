// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

/** Set (never trusted for its value — see `findActiveImpersonation`'s
 *  doc) by the impersonation start/exit routes purely so the 99.9% of
 *  requests that are never a platform admin mid-impersonation skip the
 *  extra `admin_impersonation_sessions` round trip below entirely. */
export const IMPERSONATION_COOKIE = "zdelivery_impersonating";

/** How long an "Acessar Empresa" grant lasts before it stops being
 *  honored on its own (the exit button ends it sooner). One number,
 *  shared by the start route (grant's `expires_at`) and its cookie
 *  (`maxAge`) so the two can never drift out of sync. A support
 *  session that runs long just starts a fresh one. */
export const IMPERSONATION_SESSION_MINUTES = 60;

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves.
   *  Stays the REAL platform admin's own id while impersonating — see
   *  `impersonating` below — `accountId`/`role` are what moves. */
  userId: string;
  /** Effective account_id — the caller's own (from their profile row),
   *  or the target account while impersonating (migration 080). */
  accountId: string;
  /** Effective role — the caller's own, or the impersonation grant's
   *  `target_role` (always 'owner' today) while impersonating. */
  role: AccountRole;
  /** Lightweight account meta — id + name + status. */
  account: { id: string; name: string; status: string };
  /** True when this context comes from a live "Acessar Empresa" grant
   *  (migration 080) rather than the caller's own profile row. */
  impersonating: boolean;
}

/**
 * Shared core for `getCurrentAccount()`/`getCurrentAccountAllowSuspended()`.
 * `allowSuspended` exists ONLY for the handful of billing routes
 * (`/api/billing/current-plan`, `/api/billing/invoices`,
 * `/api/billing/invoices/[id]/checkout`) — a suspended tenant must
 * still be able to see and pay the very invoice that suspended them,
 * or automatic suspend-on-overdue becomes a dead end. Every other
 * caller goes through `getCurrentAccount()`, which keeps blocking
 * suspended accounts as before.
 */
async function resolveAccountContext(allowSuspended: boolean): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  // A live impersonation grant (migration 080) wins over the caller's
  // own profile — while it's active, every page/route should operate
  // on the target account, not the admin's own. Gated behind a cheap
  // cookie check first: the cookie's VALUE is never trusted (the real
  // check below always re-verifies against admin_user_id = auth.uid()
  // in the grants table, so a forged/stale cookie just falls through
  // to "no active grant" — it exists purely so the overwhelming
  // majority of requests, from users who are never a platform admin
  // mid-impersonation, skip the extra query entirely.
  const impersonatingCookie = (await cookies()).get(IMPERSONATION_COOKIE)?.value === "1";
  const impersonation = impersonatingCookie
    ? await findActiveImpersonation(supabase, user.id)
    : null;

  let accountId: string;
  let role: AccountRole;
  if (impersonation) {
    accountId = impersonation.accountId;
    role = impersonation.role;
  } else {
    const { data, error } = await supabase
      .from("profiles")
      .select("account_id, account_role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("[getCurrentAccount] profile fetch error:", error);
      throw new ForbiddenError("Could not load account context");
    }
    if (!data || !data.account_id || !data.account_role) {
      // Pre-migration profile, or a manual insert that skipped the
      // signup trigger. The user is authenticated but the app has
      // no way to scope their queries — treat as forbidden.
      throw new ForbiddenError("Profile is not linked to an account");
    }
    if (!isAccountRole(data.account_role)) {
      // The DB enum should make this impossible, but a future
      // migration that broadens the enum without updating TS would
      // hit this — surface it rather than silently widening.
      throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
    }
    accountId = data.account_id;
    role = data.account_role;
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name, status")
    .eq("id", accountId)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (account.status === "suspended" && !allowSuspended) {
    // Migration 062 — a suspended account is blocked from every
    // session-authenticated API route in one place. The dashboard UI
    // also blocks earlier (DashboardShellInner), this is the
    // server-side backstop for direct API calls.
    throw new ForbiddenError("Account is suspended");
  }

  return {
    supabase,
    userId: user.id,
    accountId,
    role,
    account: { id: account.id, name: account.name, status: account.status },
    impersonating: impersonation !== null,
  };
}

/**
 * Migration 080 — "Acessar Empresa". A platform admin with a live,
 * unexpired impersonation grant sees the TARGET account here instead
 * of their own — every table's RLS already honors the same grant via
 * `is_account_member` (see the migration's doc comment), so once this
 * one seam returns the target's context, every route built on
 * `getCurrentAccount`/`requireRole` transparently operates as that
 * account, with zero per-route changes.
 *
 * Best-effort: any failure reading the grants table (missing
 * migration, transient error) falls through to the caller's own
 * account exactly as before impersonation existed — a broken grant
 * lookup must never lock an admin out of their own account context.
 */
async function findActiveImpersonation(
  supabase: SupabaseClient,
  adminUserId: string,
): Promise<{ accountId: string; role: AccountRole } | null> {
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
    if (!isAccountRole(data.target_role)) return null;
    return { accountId: data.target_account_id as string, role: data.target_role };
  } catch {
    return null;
  }
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand), or if the account is suspended.
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  return resolveAccountContext(false);
}

/**
 * Same as `getCurrentAccount()`, except a suspended account does NOT
 * throw. Use only for routes a suspended tenant must still be able to
 * reach (see the docstring on `resolveAccountContext`).
 */
export async function getCurrentAccountAllowSuspended(): Promise<AccountContext> {
  return resolveAccountContext(true);
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
