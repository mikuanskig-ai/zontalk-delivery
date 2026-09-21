"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Building2,
  Users,
  UserCheck,
  Smartphone,
  Ticket,
  TicketCheck,
  Contact,
  MessageSquare,
  Send,
  Inbox,
  Receipt,
  Cpu,
  MemoryStick,
  HardDrive,
  Server,
  RotateCw,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

interface AdminStats {
  version: string;
  accounts: { total: number; active: number; suspendedManual: number; suspendedOverdue: number };
  users: { total: number; online: number };
  connections: { total: number; connected: number };
  conversations: { total: number; open: number; pending: number; closed: number };
  contacts: { total: number };
  messages: { total: number; sent: number; received: number };
  invoices: { paidCents: number; outstandingCents: number };
}

interface ServerStatus {
  general: { hostname: string; platform: string; cpuModel: string | null };
  cpu: { count: number; usagePercent: number };
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  uptimeSeconds: number;
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  wuzapi: { reachable: boolean; totalSessions: number; connectedSessions: number } | null;
}

// Server health is cheap and changes second to second; business
// counters are heavier queries and change slowly.
const SERVER_REFRESH_MS = 10_000;
const STATS_REFRESH_MS = 30_000;

const GB = 1024 * 1024 * 1024;

function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Business/usage stats (Fase 1) + server health (Fase 2) + the
 *  restart action (Fase 3) — the new "visão completa" landing tab of
 *  the platform admin panel, alongside the pre-existing accounts
 *  table (now its own AdminAccountsTab). */
export function AdminDashboardTab() {
  const t = useTranslations("Admin.dashboard");

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [serverError, setServerError] = useState(false);
  const [serverUpdatedAt, setServerUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { confirm, dialog } = useConfirmDialog();

  // `silent` = background refresh: keep showing the last good numbers
  // (no skeleton flash) and never replace them with an error card — a
  // single failed poll (or the backend restarting on purpose) should
  // not blank the panel; the next tick just tries again.
  const loadStats = useCallback((silent = false) => {
    if (!silent) {
      setStatsError(false);
      setStats(null);
    }
    return fetch("/api/admin/stats", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        setStats(data as AdminStats);
        setStatsError(false);
      })
      .catch(() => {
        if (!silent) setStatsError(true);
      });
  }, []);

  const loadServer = useCallback((silent = false) => {
    if (!silent) {
      setServerError(false);
      setServer(null);
    }
    return fetch("/api/admin/server-status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        setServer(data as ServerStatus);
        setServerError(false);
        setServerUpdatedAt(new Date());
      })
      .catch(() => {
        if (!silent) setServerError(true);
      });
  }, []);

  useEffect(() => {
    loadStats();
    loadServer();
  }, [loadStats, loadServer]);

  // Periodic refresh while the tab is visible, plus an immediate
  // refresh when the admin comes back to a tab that sat in the
  // background (browsers throttle timers there, so the numbers would
  // otherwise be stale until the next tick).
  useEffect(() => {
    const tick = (fn: () => void) => () => {
      if (document.visibilityState === "visible") fn();
    };
    const serverId = setInterval(tick(() => void loadServer(true)), SERVER_REFRESH_MS);
    const statsId = setInterval(tick(() => void loadStats(true)), STATS_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void loadServer(true);
        void loadStats(true);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(serverId);
      clearInterval(statsId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadServer, loadStats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadServer(true), loadStats(true)]);
    setRefreshing(false);
  };

  const handleRestart = async () => {
    const ok = await confirm({
      title: t("restartConfirmTitle"),
      description: t("restartConfirmDesc"),
      confirmLabel: t("restartConfirmButton"),
      destructive: true,
    });
    if (!ok) return;
    setRestarting(true);
    try {
      const res = await fetch("/api/admin/restart", { method: "POST" });
      if (res.ok) {
        toast.success(t("restartSuccess"));
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t("restartFailed"));
      }
    } catch {
      toast.error(t("restartFailed"));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-8">
      {dialog}

      <section>
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          {t("businessTitle")}
        </h2>
        {statsError ? (
          <EmptyState
            title={t("loadFailed")}
            action={
              <Button size="sm" variant="outline" onClick={() => void loadStats()}>
                {t("retry")}
              </Button>
            }
          />
        ) : !stats ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title={t("systemVersion")} value={`v${stats.version}`} icon={Server} subtitle={t("systemVersionSubtitle")} />
            <MetricCard title={t("accountsTotal")} value={stats.accounts.total.toLocaleString()} icon={Building2} />
            <MetricCard title={t("accountsActive")} value={stats.accounts.active.toLocaleString()} icon={Building2} />
            <MetricCard
              title={t("accountsSuspended")}
              value={(stats.accounts.suspendedManual + stats.accounts.suspendedOverdue).toLocaleString()}
              icon={Building2}
              subtitle={t("accountsSuspendedSubtitle", { count: stats.accounts.suspendedOverdue })}
            />
            <MetricCard title={t("usersTotal")} value={stats.users.total.toLocaleString()} icon={Users} />
            <MetricCard title={t("usersOnline")} value={stats.users.online.toLocaleString()} icon={UserCheck} />
            <MetricCard
              title={t("connectionsTotal")}
              value={stats.connections.total.toLocaleString()}
              icon={Smartphone}
              subtitle={t("connectionsConnectedSubtitle", { count: stats.connections.connected })}
            />
            <MetricCard title={t("conversationsTotal")} value={stats.conversations.total.toLocaleString()} icon={Ticket} />
            <MetricCard title={t("conversationsOpen")} value={stats.conversations.open.toLocaleString()} icon={Ticket} />
            <MetricCard title={t("conversationsPending")} value={stats.conversations.pending.toLocaleString()} icon={Ticket} />
            <MetricCard title={t("conversationsClosed")} value={stats.conversations.closed.toLocaleString()} icon={TicketCheck} />
            <MetricCard title={t("contactsTotal")} value={stats.contacts.total.toLocaleString()} icon={Contact} />
            <MetricCard title={t("messagesTotal")} value={stats.messages.total.toLocaleString()} icon={MessageSquare} />
            <MetricCard title={t("messagesSent")} value={stats.messages.sent.toLocaleString()} icon={Send} />
            <MetricCard title={t("messagesReceived")} value={stats.messages.received.toLocaleString()} icon={Inbox} />
            <MetricCard title={t("invoicesPaid")} value={formatCurrency(stats.invoices.paidCents / 100, "BRL")} icon={Receipt} />
            <MetricCard title={t("invoicesOutstanding")} value={formatCurrency(stats.invoices.outstandingCents / 100, "BRL")} icon={Receipt} />
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            {t("serverTitle")}
          </h2>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {t("refreshButton")}
            </Button>
            <Button size="sm" variant="destructive" onClick={handleRestart} disabled={restarting}>
              {restarting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RotateCw className="mr-1.5 h-4 w-4" />
              )}
              {t("restartButton")}
            </Button>
          </div>
        </div>
        {serverError ? (
          <EmptyState
            title={t("loadFailed")}
            action={
              <Button size="sm" variant="outline" onClick={() => void loadServer()}>
                {t("retry")}
              </Button>
            }
          />
        ) : !server ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                title={t("cpuUsage")}
                value={`${server.cpu.usagePercent}%`}
                icon={Cpu}
                subtitle={t("cpuCount", { count: server.cpu.count })}
              />
              <MetricCard
                title={t("memoryUsage")}
                value={`${server.memory.usedPercent}%`}
                icon={MemoryStick}
                subtitle={t("memorySubtitle", {
                  free: formatGb(server.memory.freeBytes),
                  total: formatGb(server.memory.totalBytes),
                })}
              />
              <MetricCard
                title={t("diskUsage")}
                value={server.disk ? `${server.disk.usedPercent}%` : t("unavailable")}
                icon={HardDrive}
                subtitle={
                  server.disk
                    ? t("diskSubtitle", {
                        free: formatGb(server.disk.freeBytes),
                        total: formatGb(server.disk.totalBytes),
                      })
                    : undefined
                }
              />
              <MetricCard
                title={t("wuzapiStatus")}
                value={
                  !server.wuzapi
                    ? t("notConfigured")
                    : server.wuzapi.reachable
                      ? t("operational")
                      : t("unavailable")
                }
                icon={Smartphone}
                subtitle={
                  server.wuzapi?.reachable
                    ? t("wuzapiSessionsSubtitle", {
                        connected: server.wuzapi.connectedSessions,
                        total: server.wuzapi.totalSessions,
                      })
                    : undefined
                }
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("generalInfo", {
                hostname: server.general.hostname,
                platform: server.general.platform,
                uptime: formatUptime(server.uptimeSeconds),
              })}
              {serverUpdatedAt &&
                ` · ${t("updatedAt", {
                  time: serverUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
                })}`}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
