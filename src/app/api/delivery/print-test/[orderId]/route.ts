import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// GET /api/delivery/print-test/[orderId]  (agent+)
//
// Polled by the simulator UI right after POST /api/delivery/print-test
// to show "aguardando agente / impresso / falhou" — reads the SAME
// print_jobs row the real pipeline already writes (see
// enqueuePrintJob), no test-specific status tracking needed.
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { orderId } = await params;

    // Account-scoped on BOTH columns — this route only ever needs to
    // read a print_jobs row this same account's own print-test POST
    // just created, never another tenant's.
    const { data: job, error } = await supabase
      .from('print_jobs')
      .select('status, error, printed_at, claimed_at, created_at')
      .eq('order_id', orderId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[delivery/print-test/[orderId] GET] fetch error:', error);
      return NextResponse.json({ error: 'Failed to load print job status' }, { status: 500 });
    }
    if (!job) {
      return NextResponse.json({ error: 'Print job not found' }, { status: 404 });
    }

    return NextResponse.json({
      status: job.status,
      error: job.error,
      printed_at: job.printed_at,
      claimed_at: job.claimed_at,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
