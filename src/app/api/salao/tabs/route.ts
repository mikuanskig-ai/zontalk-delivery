// POST /api/salao/tabs — abre a comanda de uma mesa (ou devolve a que já
// está aberta) ou uma venda de balcão (table_id ausente).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { openTab } from '@/lib/salao/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'open_tab' });
    const body = await request.json().catch(() => ({}));
    const tableId = typeof body?.table_id === 'string' && body.table_id ? body.table_id : null;
    const guests = Number(body?.guests) || 1;
    const customerName =
      typeof body?.customer_name === 'string' && body.customer_name.trim() ? body.customer_name.trim().slice(0, 80) : null;
    const result = await openTab(ctx, { tableId, guests, customerName });
    return NextResponse.json(result, { status: result.existing ? 200 : 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
