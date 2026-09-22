import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("redirects a signed-in user away from `/` to /dashboard", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest("https://app.test/"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for an anonymous visitor to `/` — the landing page renders", async () => {
    mockUser = null;

    const res = await middleware(new NextRequest("https://app.test/"));

    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — 'Acessar empresa' auto-exit timeout (2026-09-22)", () => {
  const SECRET = "c".repeat(64);
  const NOW = 1_800_000_000_000;

  async function signTicket(overrides: Record<string, unknown> = {}) {
    const { signReturnToken } = await import("@/lib/auth/login-as");
    return signReturnToken(
      {
        adminUserId: "admin-1",
        adminEmail: "admin@zontalk.shop",
        targetUserId: "owner-1",
        accountId: "acc-1",
        lastActiveAt: NOW,
        exp: NOW + 8 * 60 * 60 * 1000,
        ...overrides,
      } as never,
      SECRET,
    );
  }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = SECRET;
    mockUser = { id: "owner-1" };
    refreshedCookies = [];
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("passes through — well within the timeout, ticket still fresh", async () => {
    const ticket = await signTicket();
    const res = await middleware(
      new NextRequest("https://app.test/inbox", {
        headers: { cookie: `zdelivery_imp=1; zdelivery_admin_return=${ticket}` },
      }),
    );
    expect(res.headers.get("location")).toBeNull();
  });

  it("renews the ticket (idle clock resets) on a normal page navigation — active work is never cut off mid-task", async () => {
    const { verifyReturnToken } = await import("@/lib/auth/login-as");
    const ticket = await signTicket();
    // 25 minutes in — still under the 30-minute idle timeout, but this is
    // exactly the case the fixed-from-start version got wrong.
    vi.setSystemTime(NOW + 25 * 60 * 1000);
    const res = await middleware(
      new NextRequest("https://app.test/inbox", {
        headers: { cookie: `zdelivery_imp=1; zdelivery_admin_return=${ticket}` },
      }),
    );
    expect(res.headers.get("location")).toBeNull();
    const renewed = res.cookies.get("zdelivery_admin_return")?.value;
    expect(renewed).toBeDefined();
    const payload = verifyReturnToken(renewed, SECRET, NOW + 25 * 60 * 1000);
    expect(payload?.lastActiveAt).toBe(NOW + 25 * 60 * 1000);

    // A second request, another 25 minutes later (50 min after the visit
    // began — well past a FIXED 30-min-from-start cap) still passes
    // through, because activity at the 25-min mark reset the idle clock.
    vi.setSystemTime(NOW + 50 * 60 * 1000);
    const res2 = await middleware(
      new NextRequest("https://app.test/inbox", {
        headers: { cookie: `zdelivery_imp=1; zdelivery_admin_return=${renewed}` },
      }),
    );
    expect(res2.headers.get("location")).toBeNull();
  });

  it("redirects to the auto-exit route once AUTO_EXIT_AFTER_MS has elapsed", async () => {
    const ticket = await signTicket();
    vi.setSystemTime(NOW + 30 * 60 * 1000);
    const res = await middleware(
      new NextRequest("https://app.test/inbox", {
        headers: { cookie: `zdelivery_imp=1; zdelivery_admin_return=${ticket}` },
      }),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/api/admin/impersonate/exit");
    expect(location.searchParams.get("next")).toBe("/inbox");
  });

  it("redirects when the flag cookie is set but the return ticket is missing/corrupt", async () => {
    const res = await middleware(
      new NextRequest("https://app.test/inbox", { headers: { cookie: "zdelivery_imp=1" } }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/api/admin/impersonate/exit");
  });

  it("never redirects an API call — an in-flight fetch must get its expected JSON, not a 307", async () => {
    const ticket = await signTicket();
    vi.setSystemTime(NOW + 30 * 60 * 1000);
    const res = await middleware(
      new NextRequest("https://app.test/api/conversations", {
        headers: { cookie: `zdelivery_imp=1; zdelivery_admin_return=${ticket}` },
      }),
    );
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not check at all when not impersonating (no flag cookie)", async () => {
    const res = await middleware(new NextRequest("https://app.test/inbox"));
    expect(res.headers.get("location")).toBeNull();
  });
});
