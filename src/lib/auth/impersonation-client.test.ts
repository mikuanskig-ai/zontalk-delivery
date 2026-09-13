import { describe, expect, it } from "vitest";
import { findActiveImpersonationClient } from "./impersonation-client";

function makeSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("findActiveImpersonationClient", () => {
  it("returns the grant when one is active", async () => {
    const supabase = makeSupabase({
      data: { target_account_id: "target-acct", target_role: "owner" },
      error: null,
    });
    const grant = await findActiveImpersonationClient(supabase, "admin-1");
    expect(grant).toEqual({ accountId: "target-acct", role: "owner" });
  });

  it("returns null when there is no active grant", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    expect(await findActiveImpersonationClient(supabase, "admin-1")).toBeNull();
  });

  it("returns null (never throws) when the query errors — e.g. pre-080 schema", async () => {
    const supabase = makeSupabase({ data: null, error: { code: "42P01" } });
    expect(await findActiveImpersonationClient(supabase, "admin-1")).toBeNull();
  });

  it("returns null (never throws) when the client itself throws", async () => {
    const supabase = {
      from: () => {
        throw new Error("boom");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(await findActiveImpersonationClient(supabase, "admin-1")).toBeNull();
  });
});
