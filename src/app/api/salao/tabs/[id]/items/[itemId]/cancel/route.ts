// POST /api/salao/tabs/[id]/items/[itemId]/cancel — cancela um item já
// lançado. Exige permissão (por padrão só caixa/gerente), pede motivo e
// avisa a cozinha com um ticket.

import { NextResponse } from 'next/server';
import { SalaoError, requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { cancelItem } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'cancel_item' });
    const { id, itemId } = await params;
    const body = await request.json().catch(() => null);
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    if (!reason.trim()) throw new SalaoError(400, 'reason_required', 'Informe o motivo do cancelamento.');
    return NextResponse.json(await cancelItem(ctx, id, itemId, reason));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
