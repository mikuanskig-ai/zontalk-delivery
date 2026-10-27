// POST /api/salao/tabs/[id]/transfer — muda a comanda de mesa; se a
// mesa de destino já tem comanda, junta as duas.

import { NextResponse } from 'next/server';
import { SalaoError, requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { transferTab } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'transfer_tab' });
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const toTableId = typeof body?.to_table_id === 'string' ? body.to_table_id : '';
    if (!toTableId) throw new SalaoError(400, 'invalid_body', 'Escolha a mesa de destino.');
    return NextResponse.json(await transferTab(ctx, id, toTableId));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
