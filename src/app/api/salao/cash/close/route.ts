// POST /api/salao/cash/close — fecha o caixa com o dinheiro contado,
// calcula a diferença e imprime o relatório na impressora do caixa.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { closeCash } from '@/lib/salao/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'close_cash' });
    const body = await request.json().catch(() => null);
    return NextResponse.json(await closeCash(ctx, body?.counted_cash, body?.notes));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
