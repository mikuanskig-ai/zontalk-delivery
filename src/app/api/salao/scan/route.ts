// POST /api/salao/scan — o garçom leu o QR de uma mesa: abre a comanda
// dela (ou devolve a que já está aberta) e diz para onde ir.

import { NextResponse } from 'next/server';
import { SalaoError, requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { openTab } from '@/lib/salao/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'open_tab' });
    const body = await request.json().catch(() => null);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!/^[0-9a-f]{32}$/.test(token)) throw new SalaoError(400, 'invalid_qr', 'Este QR code não é de uma mesa.');

    const { data: table } = await ctx.db
      .from('salao_tables')
      .select('id, number')
      .eq('qr_token', token)
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .maybeSingle();
    if (!table) throw new SalaoError(404, 'table_not_found', 'Mesa não encontrada. O QR pode ter sido trocado.');

    const { tab, existing } = await openTab(ctx, { tableId: table.id, guests: 1, customerName: null });
    return NextResponse.json({ tab_id: tab.id, table_number: table.number, existing });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
