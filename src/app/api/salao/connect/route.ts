// ============================================================
// POST /api/salao/connect — conecta um celular ao salão.
//
// Público (o celular ainda não tem nada): o dono gera um código de 6
// dígitos em Configurações > Salão > Aparelhos (vale 10 minutos, uso
// único) e o garçom digita aqui. Em troca recebe um cookie httpOnly com
// o token do aparelho (o banco guarda só o hash). Limite de tentativas
// por IP, porque 6 dígitos são adivinháveis por força bruta.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { hasModule } from '@/lib/accounts/modules';
import { isValidPairingCode, newDeviceToken, pairingCodeHmac, sha256Hex } from '@/lib/salao/crypto';
import { getClientIp, setDeviceCookie } from '@/lib/salao/context';

export async function POST(request: Request) {
  const limit = checkRateLimit(`salao-connect:${getClientIp(request)}`, { limit: 8, windowMs: 60_000 });
  if (!limit.success) return rateLimitResponse(limit);

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!isValidPairingCode(code)) {
    return NextResponse.json({ error: 'invalid_code', message: 'O código tem 6 números.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();

  // Marca como usado de forma condicional (used_at IS NULL): dois celulares
  // digitando o mesmo código ao mesmo tempo — só um consegue.
  const { data: claimed } = await db
    .from('salao_pairing_codes')
    .update({ used_at: nowIso })
    .eq('code_hmac', pairingCodeHmac(code))
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select('id, account_id, device_name')
    .maybeSingle();

  if (!claimed) {
    return NextResponse.json(
      { error: 'invalid_code', message: 'Código inválido ou vencido. Peça um novo ao responsável.' },
      { status: 404 },
    );
  }

  const { data: account } = await db
    .from('accounts')
    .select('name, enabled_modules, status')
    .eq('id', claimed.account_id)
    .maybeSingle();
  if (!account || account.status === 'suspended' || !hasModule(account, 'salao')) {
    return NextResponse.json(
      { error: 'module_disabled', message: 'O módulo Salão não está ligado nesta conta.' },
      { status: 403 },
    );
  }

  const token = newDeviceToken();
  const { error } = await db.from('salao_devices').insert({
    account_id: claimed.account_id,
    name: claimed.device_name,
    token_hash: sha256Hex(token),
    last_seen_at: nowIso,
  });
  if (error) {
    console.error('[salao/connect] falha ao criar aparelho:', error.message);
    return NextResponse.json({ error: 'internal', message: 'Não foi possível conectar. Tente de novo.' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, account_name: account.name });
  setDeviceCookie(res, token);
  return res;
}
