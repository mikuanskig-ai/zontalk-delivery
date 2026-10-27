// GET /api/salao/cash/[id]/report — relatório de um caixa (para a tela e
// para a página de impressão pelo navegador).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { buildCashReport } from '@/lib/salao/service';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'open_cash' });
    const { id } = await params;
    return NextResponse.json({ report: await buildCashReport(ctx, id), account_name: ctx.account.name });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
