// POST /api/salao/cash/movements — sangria (tirar dinheiro) ou
// suprimento (colocar troco) no caixa aberto.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { addCashMovement } from '@/lib/salao/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'cash_movement' });
    const body = await request.json().catch(() => null);
    await addCashMovement(ctx, { kind: body?.kind, amount: body?.amount, reason: body?.reason });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
