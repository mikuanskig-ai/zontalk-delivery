// ============================================================
// GET/POST /api/salao/admin/staff — equipe do salão (painel, admin+).
// Cada pessoa tem um papel (garçom, caixa, gerente) e um PIN de 4 a 6
// dígitos, único na conta. O PIN nunca é devolvido nem guardado em
// texto: só o HMAC dele.
// ============================================================

import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';
import { isValidPin, pinHmac } from '@/lib/salao/crypto';
import { isSalaoRole } from '@/lib/salao/permissions';

export async function GET() {
  try {
    const admin = await requireSalaoAdmin();
    const { data } = await admin.db
      .from('salao_staff')
      .select('id, name, role, is_active, created_at')
      .eq('account_id', admin.accountId)
      .order('name');
    return NextResponse.json({ staff: data ?? [] });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireSalaoAdmin();
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) throw new SalaoError(400, 'invalid_name', 'Informe o nome.');
    if (!isSalaoRole(body?.role)) throw new SalaoError(400, 'invalid_role', 'Escolha garçom, caixa ou gerente.');
    if (!isValidPin(body?.pin)) throw new SalaoError(400, 'invalid_pin', 'O PIN deve ter de 4 a 6 números.');

    const { data, error } = await admin.db
      .from('salao_staff')
      .insert({ account_id: admin.accountId, name, role: body.role, pin_hmac: pinHmac(admin.accountId, body.pin) })
      .select('id, name, role, is_active')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new SalaoError(409, 'pin_in_use', 'Este PIN já é de outra pessoa. Escolha outro.');
      }
      console.error('[salao/admin/staff] falha ao criar:', error.message);
      throw new SalaoError(500, 'internal', 'Não foi possível cadastrar.');
    }
    return NextResponse.json({ staff: data }, { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
