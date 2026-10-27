// PATCH/DELETE /api/salao/admin/tables/[id] — edita ou remove uma mesa.
// Uma mesa que já teve comanda não é apagada (o histórico aponta para ela):
// é desativada. Uma mesa com comanda aberta não pode ser desativada.

import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';

function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

async function hasOpenTab(db: Awaited<ReturnType<typeof requireSalaoAdmin>>['db'], accountId: string, tableId: string) {
  const { count } = await db
    .from('salao_tabs')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('table_id', tableId)
    .in('status', ['open', 'bill_requested']);
  return (count ?? 0) > 0;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SalaoError(400, 'invalid_body', 'Dados inválidos.');

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = cleanText(body.name, 40);
    if (body.area !== undefined) patch.area = cleanText(body.area, 40);
    if (body.number !== undefined) {
      const number = Math.trunc(Number(body.number));
      if (!Number.isFinite(number) || number < 1) throw new SalaoError(400, 'invalid_number', 'Informe o número da mesa.');
      patch.number = number;
      patch.position = number;
    }
    if (typeof body.is_active === 'boolean') {
      if (!body.is_active && (await hasOpenTab(admin.db, admin.accountId, id))) {
        throw new SalaoError(409, 'table_busy', 'Esta mesa tem uma comanda aberta. Feche a comanda antes de desativar.');
      }
      patch.is_active = body.is_active;
    }
    if (Object.keys(patch).length === 0) throw new SalaoError(400, 'invalid_body', 'Nada para alterar.');

    const { data, error } = await admin.db
      .from('salao_tables')
      .update(patch)
      .eq('id', id)
      .eq('account_id', admin.accountId)
      .select('id, number, name, area, is_active')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new SalaoError(409, 'duplicate_number', 'Já existe uma mesa com esse número.');
      throw new SalaoError(500, 'internal', 'Não foi possível salvar.');
    }
    if (!data) throw new SalaoError(404, 'table_not_found', 'Mesa não encontrada.');
    return NextResponse.json({ table: data });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    if (await hasOpenTab(admin.db, admin.accountId, id)) {
      throw new SalaoError(409, 'table_busy', 'Esta mesa tem uma comanda aberta. Feche a comanda antes de remover.');
    }
    const { count: history } = await admin.db
      .from('salao_tabs')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', admin.accountId)
      .eq('table_id', id);

    if ((history ?? 0) > 0) {
      await admin.db.from('salao_tables').update({ is_active: false }).eq('id', id).eq('account_id', admin.accountId);
      return NextResponse.json({ deleted: false, deactivated: true });
    }
    await admin.db.from('salao_tables').delete().eq('id', id).eq('account_id', admin.accountId);
    return NextResponse.json({ deleted: true, deactivated: false });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
