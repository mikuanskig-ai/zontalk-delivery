// DELETE /api/salao/admin/devices/[id] — desconecta um aparelho (celular
// perdido, funcionário que saiu). Vale já na próxima chamada dele.

import { NextResponse } from 'next/server';
import { requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    await admin.db
      .from('salao_devices')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', admin.accountId)
      .is('revoked_at', null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
