// PATCH/DELETE /api/salao/admin/staff/[id] — muda nome, papel, PIN ou
// desativa/remove. Quem é desativado perde o acesso na próxima chamada
// (a sessão confere o banco a cada requisição).

import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';
import { isValidPin, pinHmac } from '@/lib/salao/crypto';
import { isSalaoRole } from '@/lib/salao/permissions';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SalaoError(400, 'invalid_body', 'Dados inválidos.');

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
      if (!name) throw new SalaoError(400, 'invalid_name', 'Informe o nome.');
      patch.name = name;
    }
    if (body.role !== undefined) {
      if (!isSalaoRole(body.role)) throw new SalaoError(400, 'invalid_role', 'Escolha garçom, caixa ou gerente.');
      patch.role = body.role;
    }
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
    if (body.pin !== undefined && body.pin !== '') {
      if (!isValidPin(body.pin)) throw new SalaoError(400, 'invalid_pin', 'O PIN deve ter de 4 a 6 números.');
      patch.pin_hmac = pinHmac(admin.accountId, body.pin);
    }
    if (Object.keys(patch).length === 0) throw new SalaoError(400, 'invalid_body', 'Nada para alterar.');

    const { data, error } = await admin.db
      .from('salao_staff')
      .update(patch)
      .eq('id', id)
      .eq('account_id', admin.accountId)
      .select('id, name, role, is_active')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new SalaoError(409, 'pin_in_use', 'Este PIN já é de outra pessoa. Escolha outro.');
      throw new SalaoError(500, 'internal', 'Não foi possível salvar.');
    }
    if (!data) throw new SalaoError(404, 'staff_not_found', 'Funcionário não encontrado.');
    return NextResponse.json({ staff: data });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireSalaoAdmin();
    const { id } = await params;
    // O histórico guarda o nome congelado em cada comanda, então apagar é seguro.
    await admin.db.from('salao_staff').delete().eq('id', id).eq('account_id', admin.accountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
