"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ClipboardList, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { formatCurrency } from "@/lib/currency";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";
import { HOME_STAGES, groupByStage, summarizeDay, type HomeStage } from "@/lib/delivery/home-board";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { HomeOrderCard } from "./home-order-card";
import { OrderDetailSheet } from "./order-detail-sheet";

// Tailwind needs these as literal class names, not built from the stage name.
const STAGE_ACCENT: Record<HomeStage, string> = {
  new: "border-t-primary",
  preparing: "border-t-amber-500",
  delivering: "border-t-sky-500",
  done: "border-t-emerald-500",
};

// A new order's row and its items are written a moment apart — reading
// the instant the order event lands can catch the order without its
// items. A short settle delay makes the reload see both.
const RELOAD_SETTLE_MS = 600;

/**
 * The delivery account's home screen: what is happening today, laid out
 * the way a restaurant works — new, being prepared, out for delivery,
 * done — with the day's numbers on top. Updates live as orders arrive.
 */
export function TodayOrdersHome() {
  const t = useTranslations("Delivery.todayHome");
  const locale = useLocale();
  const supabase = useMemo(() => createClient(), []);
  const { accountId, defaultCurrency } = useAuth();
  const canEdit = useCan("send-messages");
  const unread = useTotalUnread();

  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeliveryOrder | null>(null);
  // Rendered after mount: server and browser can disagree on what "today"
  // is (UTC vs. the shop's timezone), which would be a hydration mismatch.
  const [todayLabel, setTodayLabel] = useState<string | null>(null);

  useEffect(() => {
    setTodayLabel(
      new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(new Date()),
    );
  }, [locale]);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from("delivery_orders")
      .select("*, contact:contacts(*), items:delivery_order_items(*)")
      .eq("account_id", accountId)
      .gte("created_at", startOfLocalDay().toISOString())
      .not("status", "in", "(cancelled,draft)")
      .order("created_at", { ascending: true });
    if (error) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setOrders((data ?? []) as DeliveryOrder[]);
  }, [supabase, accountId]);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [accountId, load]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadRef.current(), RELOAD_SETTLE_MS);
    };
    const channel = supabase
      .channel(`delivery-home-${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "delivery_orders", filter: `account_id=eq.${accountId}` },
        scheduleReload,
      )
      .subscribe();
    // A tab left in the background can miss events — catch up on return.
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, accountId]);

  async function move(order: DeliveryOrder, to: DeliveryOrderStatus) {
    setMovingId(order.id);
    try {
      const res = await fetch(`/api/delivery/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? t("toastFailedUpdate"));
        return;
      }
      await load();
    } catch {
      toast.error(t("toastFailedUpdate"));
    } finally {
      setMovingId(null);
    }
  }

  function print(order: DeliveryOrder) {
    window.open(`/delivery/pedidos/${order.id}/imprimir`, "_blank");
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm capitalize text-muted-foreground">{todayLabel ?? " "}</p>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted/50" />
      ) : failed && orders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
          <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <HomeBoardView
          orders={orders}
          currency={defaultCurrency}
          unread={unread}
          canEdit={canEdit}
          movingId={movingId}
          onMove={move}
          onPrint={print}
          onOpenDetails={setSelected}
        />
      )}

      <OrderDetailSheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        order={selected}
        onStatusChanged={() => {
          void load();
          setSelected(null);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

interface HomeBoardViewProps {
  orders: DeliveryOrder[];
  currency: string;
  unread: number;
  canEdit: boolean;
  movingId: string | null;
  onMove: (order: DeliveryOrder, to: DeliveryOrderStatus) => void;
  onPrint: (order: DeliveryOrder) => void;
  onOpenDetails: (order: DeliveryOrder) => void;
}

/** The day's numbers plus the four columns — pure display, no data loading. */
export function HomeBoardView({ orders, currency, unread, canEdit, movingId, onMove, onPrint, onOpenDetails }: HomeBoardViewProps) {
  const t = useTranslations("Delivery.todayHome");
  const groups = useMemo(() => groupByStage(orders), [orders]);
  const summary = useMemo(() => summarizeDay(orders), [orders]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("statOrders")} value={String(summary.count)} />
        <Stat label={t("statRevenue")} value={formatCurrency(summary.revenue, currency)} />
        <Stat label={t("statTicket")} value={formatCurrency(summary.averageTicket, currency)} />
        <Link
          href="/inbox"
          className="group rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40"
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            {t("statUnread")}
          </p>
          <p className={`mt-1 text-xl font-semibold tabular-nums ${unread > 0 ? "text-primary" : "text-foreground"}`}>
            {unread}
          </p>
        </Link>
      </div>

      {summary.count === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border py-16 text-center">
          <ClipboardList className="h-10 w-10 text-muted-foreground" />
          <h2 className="mt-3 text-base font-medium text-foreground">{t("emptyTitle")}</h2>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {HOME_STAGES.map((stage) => (
            <section key={stage} className={`space-y-2 rounded-xl border-t-4 bg-muted/30 p-2 ${STAGE_ACCENT[stage]}`}>
              <div className="flex items-center justify-between px-1.5 pt-1">
                <h2 className="text-sm font-semibold text-foreground">{t(`stage.${stage}`)}</h2>
                <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                  {groups[stage].length}
                </span>
              </div>
              {groups[stage].map((order) => (
                <HomeOrderCard
                  key={order.id}
                  order={order}
                  stage={stage}
                  canEdit={canEdit}
                  busy={movingId === order.id}
                  onMove={onMove}
                  onPrint={onPrint}
                  onOpenDetails={onOpenDetails}
                />
              ))}
              {groups[stage].length === 0 && (
                <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  {t("emptyColumn")}
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
