import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    // `.is()`/`.gt()`/`.order()`/`.limit()` are chained-but-inert here —
    // only `findActiveImpersonation`'s query (admin_impersonation_sessions)
    // uses them, and its result is stubbed by table name same as every
    // other query below, not by which filters were actually applied.
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      is() {
        return builder;
      },
      gt() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

// account.ts reads the impersonation fast-path cookie directly via
// next/headers — mocked as a tiny in-memory jar the tests below set
// before each call, mirroring how `@/lib/supabase/server`'s own
// `cookies()` usage is already sidestepped by mocking that module.
let cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  }),
}));

const { getCurrentAccount, UnauthorizedError, ForbiddenError, IMPERSONATION_COOKIE } =
  await import("./account");

afterEach(() => {
  vi.clearAllMocks();
  cookieJar = new Map();
});

describe("getCurrentAccount", () => {
  it("resolves context via a plain accounts lookup, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "owner" },
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([["user_id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "admin" },
          error: null,
        },
        accounts: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: null, account_role: null }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "viewer" },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  // ------------------------------------------------------------
  // Migration 080 — "Acessar Empresa" impersonation grants.
  // ------------------------------------------------------------

  it("skips the impersonation lookup entirely when the fast-path cookie is absent — the common case for every non-admin request", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: "acct-1", account_role: "owner" }, error: null },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx.impersonating).toBe(false);
    expect(ctx.accountId).toBe("acct-1");
    // No admin_impersonation_sessions query at all — the cookie gate
    // short-circuited before the table was ever touched.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
  });

  it("returns the TARGET account's context when a live impersonation grant matches the cookie hint", async () => {
    cookieJar.set(IMPERSONATION_COOKIE, "1");
    const { client } = makeClient({
      user: { id: "admin-1" },
      byTable: {
        admin_impersonation_sessions: {
          data: { target_account_id: "target-acct", target_role: "owner" },
          error: null,
        },
        accounts: { data: { id: "target-acct", name: "Empresa Alvo" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "admin-1", // the real admin's own id — never overwritten
      accountId: "target-acct",
      role: "owner",
      account: { id: "target-acct", name: "Empresa Alvo" },
      impersonating: true,
    });
  });

  it("falls back to the caller's own profile when the cookie is set but no grant is actually active (expired/ended/revoked)", async () => {
    cookieJar.set(IMPERSONATION_COOKIE, "1");
    const { client } = makeClient({
      user: { id: "admin-1" },
      byTable: {
        admin_impersonation_sessions: { data: null, error: null },
        profiles: { data: { account_id: "own-acct", account_role: "owner" }, error: null },
        accounts: { data: { id: "own-acct", name: "Own Co" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx.impersonating).toBe(false);
    expect(ctx.accountId).toBe("own-acct");
  });

  it("falls back to the caller's own profile when the grants table query errors — a broken lookup must never lock an admin out of their own account", async () => {
    cookieJar.set(IMPERSONATION_COOKIE, "1");
    const { client } = makeClient({
      user: { id: "admin-1" },
      byTable: {
        admin_impersonation_sessions: { data: null, error: { code: "42P01" } }, // undefined_table, e.g. pre-080
        profiles: { data: { account_id: "own-acct", account_role: "admin" }, error: null },
        accounts: { data: { id: "own-acct", name: "Own Co" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx.impersonating).toBe(false);
    expect(ctx.accountId).toBe("own-acct");
  });
});
