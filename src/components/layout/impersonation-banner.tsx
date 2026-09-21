"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

/**
 * Migration 080 — "Acessar Empresa". Renders a persistent, unmissable
 * strip whenever a platform admin is viewing the dashboard as another
 * account, with the one-click way out. Deliberately loud (not a quiet
 * badge in the header) — an admin acting inside a real tenant's data
 * (sending messages, changing settings) must never lose track of
 * whose account they're in.
 */
export function ImpersonationBanner() {
  const t = useTranslations("ImpersonationBanner");
  const { isImpersonating, account, profile, user, exitImpersonation } = useAuth();
  const [exiting, setExiting] = useState(false);

  if (!isImpersonating) return null;

  async function handleExit() {
    setExiting(true);
    await exitImpersonation();
    // exitImpersonation navigates away on success; if it somehow
    // doesn't (network error swallowed inside it), don't leave the
    // button stuck disabled forever.
    setExiting(false);
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span>
        {t("loggedInAs")} <strong>{profile?.full_name || user?.email || "…"}</strong>
        {account?.name ? <> · {account.name}</> : null}
      </span>
      <button
        type="button"
        onClick={handleExit}
        disabled={exiting}
        className="flex items-center gap-1.5 rounded-md bg-amber-950/10 px-3 py-1 hover:bg-amber-950/20 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" />
        {exiting ? t("exiting") : t("exit")}
      </button>
    </div>
  );
}
