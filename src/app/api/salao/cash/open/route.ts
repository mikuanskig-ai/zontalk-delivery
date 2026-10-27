// POST /api/salao/cash/open — abre o caixa do dia com o fundo de troco.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { openCash } from '@/lib/salao/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'open_cash' });
    const body = await request.json().catch(() => null);
    return NextResponse.json({ cash: await openCash(ctx, Number(body?.opening_float ?? 0)) }, { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
