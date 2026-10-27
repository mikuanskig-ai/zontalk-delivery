// POST /api/salao/logout — "Trocar usuário": encerra a sessão de turno e
// volta para a tela do PIN. O aparelho continua conectado.

import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/salao/context';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
