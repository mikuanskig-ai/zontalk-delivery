// POST /api/salao/tabs/[id]/close — recebe os pagamentos e fecha a
// comanda. Só quem tem a permissão `close_tab` (por padrão caixa e
// gerente; o dono pode liberar para o garçom).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { closeTab } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'close_tab' });
    const { id } = await params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await closeTab(ctx, id, body?.payments));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
