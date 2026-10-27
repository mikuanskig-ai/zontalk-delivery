// POST /api/salao/admin/tables/[id]/rotate-qr — troca o código do QR da
// mesa. O QR impresso antigo deixa de funcionar na hora.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    const { data, error } = await admin.db
      .from('salao_tables')
      .update({ qr_token: randomUUID().replace(/-/g, '') })
      .eq('id', id)
      .eq('account_id', admin.accountId)
      .select('id, qr_token')
      .maybeSingle();
    if (error) throw new SalaoError(500, 'internal', 'Não foi possível trocar o QR.');
    if (!data) throw new SalaoError(404, 'table_not_found', 'Mesa não encontrada.');
    return NextResponse.json({ table: data });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
