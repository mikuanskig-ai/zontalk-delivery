"use client";

import { format, parseISO } from "date-fns";
import { Bike, Eye, Loader2, Printer, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { isPickupOrder, nextStatusForOrder, type HomeStage } from "@/lib/delivery/home-board";
import { Button } from "@/components/ui/button";
import { ElapsedBadge } from "./operations-board";
import { PaymentStatusBadge } from "./payment-status-badge";

interface HomeOrderCardProps {
  order: DeliveryOrder;
  stage: HomeStage;
  canEdit: boolean;
  busy: boolean;
  onMove: (order: DeliveryOrder, to: DeliveryOrderStatus) => void;
  onPrint: (order: DeliveryOrder) => void;
  onOpenDetails: (order: DeliveryOrder) => void;
}

/**
 * One order on the home screen, with what the kitchen and the
 * motoboy actually need on it — items, address, how it's being paid
 * (and any change to bring) — without opening anything. The big
 * button moves it to the next step; "Concluir" is a shortcut for teams
 * that don't track every step and just want it off the board.
 */
export function HomeOrderCard({ order, stage, canEdit, busy, onMove, onPrint, onOpenDetails }: HomeOrderCardProps) {
  const t = useTranslations("Delivery.todayHome");
  const next = nextStatusForOrder(order);
  const isPickup = isPickupOrder(order);
  const actionKey = isPickup && order.status === "ready" ? "action.ready_pickup" : `action.${order.status}`;
  const customer = order.contact?.name || order.customer_name || t("unknownCustomer");
  const items = order.items ?? [];

  return (
    <article className="space-y-2.5 rounded-xl border border-border bg-card p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">#{order.id.slice(0, 8).toUpperCase()}</span>
        {stage === "done" ? (
          <span className="text-xs tabular-nums text-muted-foreground">{format(parseISO(order.created_at), "HH:mm")}</span>
        ) : (
          <ElapsedBadge key={order.created_at} since={order.created_at} />
        )}
      </header>

      <div>
        <h3 className="truncate text-sm font-semibold text-foreground">{customer}</h3>
        <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          {isPickup ? <Store className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Bike className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="line-clamp-2">
            <span className="font-medium text-foreground">{isPickup ? t("pickup") : t("delivery")}</span>
            {order.delivery_address ? ` · ${order.delivery_address}` : ""}
          </span>
        </p>
      </div>

      {items.length > 0 && (
        <ul className="space-y-0.5 border-y border-border py-2 text-sm">
          {items.map((item) => {
            const addons = (item.addons_snapshot ?? []).map((a) => a.option_name).join(", ");
            return (
              <li key={item.id} className="text-foreground">
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.product_name}
                {addons && <span className="text-muted-foreground"> — {addons}</span>}
                {item.notes && <span className="block text-xs text-muted-foreground">{item.notes}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {order.notes && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300 [html[data-mode=light]_&]:text-amber-800">{order.notes}</p>
      )}

      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {order.payment_method && (
            <p className="truncate text-xs text-muted-foreground" title={order.payment_method}>
              {order.payment_method}
            </p>
          )}
          <PaymentStatusBadge status={order.payment_status} />
        </div>
        <p className="shrink-0 text-base font-semibold tabular-nums text-foreground">
          {formatCurrency(order.total, order.currency)}
        </p>
      </div>

      <div className="flex gap-1.5">
        {canEdit && next && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onMove(order, next)}
            className="h-9 flex-1 bg-primary text-sm text-primary-foreground hover:bg-primary/90"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t(actionKey)}
          </Button>
        )}
        {canEdit && next && next !== "delivered" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onMove(order, "delivered")}
            className="h-9 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
          >
            {t("finish")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPrint(order)}
          aria-label={t("print")}
          title={t("print")}
          className="h-9 border-border bg-transparent px-2.5 text-muted-foreground hover:bg-muted"
        >
          <Printer className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpenDetails(order)}
          aria-label={t("details")}
          title={t("details")}
          className="h-9 border-border bg-transparent px-2.5 text-muted-foreground hover:bg-muted"
        >
          <Eye className="h-4 w-4" />
        </Button>
      </div>
    </article>
  );
}
