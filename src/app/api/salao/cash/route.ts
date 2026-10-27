// GET /api/salao/cash — caixa de agora (com o relatório parcial) e os
// últimos caixas fechados.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { buildCashReport, loadOpenCash } from '@/lib/salao/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireSalao(request);
    const cash = await loadOpenCash(ctx);
    const report = cash ? await buildCashReport(ctx, cash.id) : null;
    const { data: history } = await ctx.db
      .from('cash_sessions')
      .select('id, opened_at, closed_at, opened_by_name, closed_by_name, opening_float, counted_cash, expected_cash, difference')
      .eq('account_id', ctx.accountId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(15);
    return NextResponse.json({ cash, report, history: history ?? [] });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
