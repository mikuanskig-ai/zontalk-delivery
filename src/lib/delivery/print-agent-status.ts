// Health of the local Zontalk Print Agent, derived from the heartbeat
// the agent already sends: every GET /api/v1/print-jobs (every ~5s)
// bumps print_configs.last_polled_at (touchPrintAgentPoll).
//
// The alert window is deliberately much wider than the 10s the pairing
// screen uses (settings/print-config.tsx isFresh): that one is for
// watching "connected" flip live, this one is for "nobody is going to
// print your orders" — a restart or a Wi-Fi blip must not page anyone.
export const AGENT_ONLINE_WINDOW_MS = 2 * 60_000

export interface PrintAgentStatusInput {
  enabled: boolean
  lastPolledAt: string | null
  pendingCount: number
  now?: number
}

export interface PrintAgentStatus {
  /** Auto-print is on for the account. */
  enabled: boolean
  /** Agent polled within the alert window. */
  online: boolean
  /** ms since the last poll; null = never polled. */
  offlineForMs: number | null
  pendingCount: number
  /** Worth interrupting someone: printing is on, the agent is silent,
   *  and there are orders actually waiting. Silent + nothing waiting
   *  (shop closed, agent off overnight) is NOT an alert. */
  needsAttention: boolean
}

export function computePrintAgentStatus(input: PrintAgentStatusInput): PrintAgentStatus {
  const now = input.now ?? Date.now()
  const offlineForMs = input.lastPolledAt ? Math.max(0, now - new Date(input.lastPolledAt).getTime()) : null
  const online = offlineForMs !== null && offlineForMs < AGENT_ONLINE_WINDOW_MS
  return {
    enabled: input.enabled,
    online,
    offlineForMs,
    pendingCount: input.pendingCount,
    needsAttention: input.enabled && !online && input.pendingCount > 0,
  }
}
