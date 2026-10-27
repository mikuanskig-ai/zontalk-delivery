// ============================================================
// POST /api/salao/pin — o funcionário se identifica no aparelho.
//
// Precisa do cookie do aparelho (conectado antes, em /connect). PIN
// certo abre uma sessão de turno de 12 h; 5 erros seguidos travam o
// aparelho por 1 minuto.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { hasModule } from '@/lib/accounts/modules';
import {
  clearPinFailures,
  isValidPin,
  pinHmac,
  pinLockRemainingMs,
  recordPinFailure,
  signSession,
} from '@/lib/salao/crypto';
import { resolveActor, setSessionCookie } from '@/lib/salao/context';
import { isSalaoRole } from '@/lib/salao/permissions';

export async function POST(request: Request) {
  const resolution = await resolveActor(request);
  if (resolution.state === 'device_required') {
    return NextResponse.json(
      { error: 'device_required', message: 'Este aparelho ainda não foi conectado ao salão.' },
      { status: 401 },
    );
  }

  // Quem já entrou pelo painel não precisa de PIN.
  if (resolution.state === 'ok') {
    return NextResponse.json({ ok: true, via: resolution.actor.via });
  }

  const { deviceId, accountId } = resolution;
  const lockMs = pinLockRemainingMs(deviceId);
  if (lockMs > 0) {
    return NextResponse.json(
      { error: 'pin_locked', message: 'Muitos erros de PIN. Aguarde um minuto e tente de novo.', retry_after_s: Math.ceil(lockMs / 1000) },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const pin = body?.pin;
  if (!isValidPin(pin)) {
    return NextResponse.json({ error: 'invalid_pin', message: 'O PIN tem de 4 a 6 números.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: account } = await db
    .from('accounts')
    .select('enabled_modules, status')
    .eq('id', accountId)
    .maybeSingle();
  if (!account || account.status === 'suspended' || !hasModule(account, 'salao')) {
    return NextResponse.json({ error: 'module_disabled', message: 'O módulo Salão não está ligado nesta conta.' }, { status: 403 });
  }

  const { data: staff } = await db
    .from('salao_staff')
    .select('id, name, role')
    .eq('account_id', accountId)
    .eq('pin_hmac', pinHmac(accountId, pin))
    .eq('is_active', true)
    .maybeSingle();

  if (!staff || !isSalaoRole(staff.role)) {
    recordPinFailure(deviceId);
    return NextResponse.json({ error: 'wrong_pin', message: 'PIN incorreto.' }, { status: 401 });
  }

  clearPinFailures(deviceId);
  const res = NextResponse.json({
    ok: true,
    actor: { name: staff.name, role: staff.role },
  });
  setSessionCookie(res, signSession({ a: accountId, d: deviceId, s: staff.id, r: staff.role }));
  return res;
}
