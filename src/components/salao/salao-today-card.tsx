"use client";

// "Salão hoje" — o resumo do salão no começo da tela inicial do restaurante:
// quantas comandas estão abertas agora, quanto já foi vendido hoje, e o
// atalho para o app do salão. Só aparece com o módulo Salão ligado.
//
// Independente do quadro de pedidos de delivery de propósito (outro
// componente, outra consulta): um problema aqui nunca derruba a tela dos
// pedidos. Atualiza a cada 20 s e quando a aba volta; sem canal realtime
// (os nomes de canal compartilhados já derrubaram o painel uma vez, v0.40.1).
// Se a consulta falhar, o cartão simplesmente não aparece.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConciergeBell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";
import { money } from "./format";

interface Summary {
  openTabs: number;
  openTotal: number;
  closedTabs: number;
  closedTotal: number;
}

const REFRESH_MS = 20_000;

export function SalaoTodayCard() {
  const supabase = useMemo(() => createClient(), []);
  const { accountId, defaultCurrency } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    async function load() {
      const [open, closed] = await Promise.all([
        supabase
          .from("salao_tabs")
          .select("total")
          .eq("account_id", accountId)
          .in("status", ["open", "bill_requested"]),
        supabase
          .from("salao_tabs")
          .select("total")
          .eq("account_id", accountId)
          .eq("status", "closed")
          .gte("closed_at", startOfLocalDay().toISOString()),
      ]);
      if (cancelled || open.error || closed.error) return;
      const sum = (rows: { total: number | string }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.total), 0);
      setSummary({
        openTabs: open.data?.length ?? 0,
        openTotal: sum(open.data),
        closedTabs: closed.data?.length ?? 0,
        closedTotal: sum(closed.data),
      });
    }

    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supabase, accountId]);

  if (!summary) return null;

  const currency = defaultCurrency || "BRL";
  return (
    <section aria-label="Salão hoje" className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ConciergeBell className="size-4 text-primary" />
          Salão hoje
        </h2>
        <Link href="/salao" className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted">
          Abrir o salão
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Comandas abertas</dt>
          <dd className="text-xl font-semibold text-foreground">{summary.openTabs}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Em aberto</dt>
          <dd className="text-xl font-semibold text-foreground">{money(summary.openTotal, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Comandas fechadas hoje</dt>
          <dd className="text-xl font-semibold text-foreground">{summary.closedTabs}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Vendido no salão hoje</dt>
          <dd className="text-xl font-semibold text-foreground">{money(summary.closedTotal, currency)}</dd>
        </div>
      </dl>
    </section>
  );
}
