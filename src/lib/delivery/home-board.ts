import type { DeliveryOrder, DeliveryOrderStatus } from "@/types";
import { STATUS_FLOW } from "./status-flow";

/**
 * The home screen's four columns. The fulfillment ladder has six
 * statuses (STATUS_FLOW), which is more steps than a kitchen wants on
 * screen — they collapse into the same four stages iFood's order
 * manager shows: new, being prepared, out for delivery, done. Moving a
 * card still walks the real ladder one status at a time.
 */
export type HomeStage = "new" | "preparing" | "delivering" | "done";

export const HOME_STAGES: HomeStage[] = ["new", "preparing", "delivering", "done"];

const STAGE_BY_STATUS: Partial<Record<DeliveryOrderStatus, HomeStage>> = {
  pending_confirmation: "new",
  confirmed: "new",
  in_production: "preparing",
  ready: "preparing",
  out_for_delivery: "delivering",
  delivered: "done",
};

/** `null` for statuses that never belong on the board (draft, cancelled). */
export function stageOf(status: DeliveryOrderStatus): HomeStage | null {
  return STAGE_BY_STATUS[status] ?? null;
}

/** The next rung of the fulfillment ladder, or `null` at the end of it. */
export function nextStatus(status: DeliveryOrderStatus): DeliveryOrderStatus | null {
  const idx = STATUS_FLOW.indexOf(status);
  return idx >= 0 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1]! : null;
}

/** An order with no delivery address is picked up at the counter (same inference the print agent uses). */
export function isPickupOrder(order: Pick<DeliveryOrder, "delivery_address">): boolean {
  return !order.delivery_address;
}

/**
 * What the main button on an order's card does. Same ladder as
 * `nextStatus`, except a pickup order never goes "out for delivery":
 * once it's ready it is handed over at the counter, which closes it.
 */
export function nextStatusForOrder(order: Pick<DeliveryOrder, "status" | "delivery_address">): DeliveryOrderStatus | null {
  if (isPickupOrder(order) && order.status === "ready") return "delivered";
  return nextStatus(order.status);
}

/**
 * Splits today's orders across the four columns. Work still to do is
 * oldest-first (the order that has waited longest is on top); finished
 * orders are newest-first (the last thing that left is on top).
 */
export function groupByStage(orders: DeliveryOrder[]): Record<HomeStage, DeliveryOrder[]> {
  const groups: Record<HomeStage, DeliveryOrder[]> = { new: [], preparing: [], delivering: [], done: [] };
  for (const order of orders) {
    const stage = stageOf(order.status);
    if (stage) groups[stage].push(order);
  }
  const byCreated = (a: DeliveryOrder, b: DeliveryOrder) => a.created_at.localeCompare(b.created_at);
  groups.new.sort(byCreated);
  groups.preparing.sort(byCreated);
  groups.delivering.sort(byCreated);
  groups.done.sort((a, b) => byCreated(b, a));
  return groups;
}

export interface DaySummary {
  count: number;
  revenue: number;
  averageTicket: number;
}

/** Counts and sums only orders that are really on the board — never drafts or cancelled ones. */
export function summarizeDay(orders: DeliveryOrder[]): DaySummary {
  const live = orders.filter((o) => stageOf(o.status) !== null);
  const revenue = live.reduce((sum, o) => sum + (o.total ?? 0), 0);
  return {
    count: live.length,
    revenue,
    averageTicket: live.length > 0 ? revenue / live.length : 0,
  };
}
