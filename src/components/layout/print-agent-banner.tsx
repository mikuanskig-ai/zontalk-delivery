"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Printer } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/accounts/modules";

const REFRESH_MS = 60_000;

interface PrintStatus {
  needsAttention: boolean;
  pendingCount: number;
  offlineForMs: number | null;
  oldest_pending_at: string | null;
}

function formatOffline(ms: number, t: ReturnType<typeof useTranslations>): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t("minutes", { count: minutes });
  return t("hours", { count: Math.floor(minutes / 60) });
}

/**
 * Loud strip (like ImpersonationBanner) shown to every member of a
 * Delivery account when auto-print is on, the Zontalk Print Agent has
 * gone silent AND orders are actually waiting to print — the exact
 * situation where the kitchen never sees an order. Quiet otherwise
 * (agent offline with nothing pending = shop closed, not an emergency).
 * Backed by GET /api/delivery/print-status.
 */
export function PrintAgentBanner() {
  const t = useTranslations("PrintAgentBanner");
  const { account, accountId, profileLoading } = useAuth();
  const moduleEnabled = hasModule(account, "delivery");
  const [status, setStatus] = useState<PrintStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/delivery/print-status", { cache: "no-store" });
      if (!res.ok) return;
      setStatus((await res.json()) as PrintStatus);
    } catch {
      // Transient network error — keep whatever we last knew.
    }
  }, []);

  useEffect(() => {
    if (profileLoading || !moduleEnabled || !accountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, state is set once the fetch settles
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [profileLoading, moduleEnabled, accountId, load]);

  if (!moduleEnabled || !status?.needsAttention) return null;

  const since = status.oldest_pending_at
    ? new Date(status.oldest_pending_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-red-600 px-4 py-2 text-sm font-medium text-white">
      <span className="flex items-center gap-2">
        <Printer className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          {t("offline")}{" "}
          {t("waiting", { count: status.pendingCount })}
          {since ? ` ${t("since", { time: since })}` : ""}
          {" · "}
          {status.offlineForMs === null ? t("neverSeen") : t("lastSeen", { time: formatOffline(status.offlineForMs, t) })}
        </span>
      </span>
      <span className="flex items-center gap-3">
        <span className="opacity-90">{t("hint")}</span>
        <Link href="/settings?tab=printing" className="rounded-md bg-white/15 px-3 py-1 hover:bg-white/25">
          {t("details")}
        </Link>
      </span>
    </div>
  );
}
