// ============================================================
// GET/POST /api/salao/admin/devices — aparelhos conectados ao salão.
//
// POST gera um código de pareamento de 6 dígitos (vale 10 minutos, uso
// único). O garçom abre /salao no celular, digita o código e o aparelho
// fica conectado; depois disso só o PIN dele é pedido.
// ============================================================

import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';
import { PAIRING_CODE_TTL_MS, newPairingCode, pairingCodeHmac } from '@/lib/salao/crypto';

export async function GET() {
  try {
    const admin = await requireSalaoAdmin();
    const nowIso = new Date().toISOString();
    const [devicesRes, codesRes] = await Promise.all([
      admin.db
        .from('salao_devices')
        .select('id, name, created_at, last_seen_at, revoked_at')
        .eq('account_id', admin.accountId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false }),
      admin.db
        .from('salao_pairing_codes')
        .select('id, device_name, expires_at')
        .eq('account_id', admin.accountId)
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false }),
    ]);
    return NextResponse.json({ devices: devicesRes.data ?? [], pending_codes: codesRes.data ?? [] });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireSalaoAdmin();
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Celular do salão';

    // O código vale para qualquer conta (o celular ainda não sabe de qual
    // é): garante que não colide com outro código ainda válido.
    const nowIso = new Date().toISOString();
    let code = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = newPairingCode();
      const { count } = await admin.db
        .from('salao_pairing_codes')
        .select('id', { count: 'exact', head: true })
        .eq('code_hmac', pairingCodeHmac(candidate))
        .is('used_at', null)
        .gt('expires_at', nowIso);
      if ((count ?? 0) === 0) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new SalaoError(500, 'internal', 'Não foi possível gerar o código. Tente de novo.');

    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
    const { error } = await admin.db.from('salao_pairing_codes').insert({
      account_id: admin.accountId,
      code_hmac: pairingCodeHmac(code),
      device_name: name,
      expires_at: expiresAt,
    });
    if (error) throw new SalaoError(500, 'internal', 'Não foi possível gerar o código. Tente de novo.');

    return NextResponse.json({ code, expires_at: expiresAt, device_name: name }, { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
