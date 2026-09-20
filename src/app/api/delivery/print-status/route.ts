import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { computePrintAgentStatus } from '@/lib/delivery/print-agent-status'

/**
 * GET /api/delivery/print-status  (any member)
 *
 * Feeds the in-app "print agent is offline" alert. Read-only, RLS-scoped
 * (print_configs / print_jobs are member-readable). "Pending" counts
 * jobs the agent has not printed yet: `pending` plus `claimed` (handed
 * to an agent that then vanished before acking).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const [{ data: config, error: cfgErr }, { count, data: oldest, error: jobsErr }] = await Promise.all([
      supabase
        .from('print_configs')
        .select('enabled, last_polled_at')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('print_jobs')
        .select('created_at', { count: 'exact' })
        .eq('account_id', accountId)
        .in('status', ['pending', 'claimed'])
        .order('created_at', { ascending: true })
        .limit(1),
    ])

    if (cfgErr || jobsErr) {
      console.error('[delivery/print-status GET] fetch error:', cfgErr ?? jobsErr)
      return NextResponse.json({ error: 'Failed to load print status' }, { status: 500 })
    }

    const status = computePrintAgentStatus({
      enabled: config?.enabled ?? false,
      lastPolledAt: config?.last_polled_at ?? null,
      pendingCount: count ?? 0,
    })

    return NextResponse.json({
      ...status,
      last_polled_at: config?.last_polled_at ?? null,
      oldest_pending_at: (oldest?.[0] as { created_at: string } | undefined)?.created_at ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
