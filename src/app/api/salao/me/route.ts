// ============================================================
// GET /api/salao/me — o que o app do salão precisa para abrir.
//
// Sempre responde 200 com `state`, para a tela decidir o que mostrar
// sem tratar 401 como erro: 'device_required' (conectar o aparelho),
// 'pin_required' (digitar o PIN) ou 'ok' (com quem é, o que pode e o
// estado do caixa).
// ============================================================

import { NextResponse } from 'next/server';
import { resolveActor, salaoErrorResponse, requireSalao, DEFAULT_SETTINGS } from '@/lib/salao/context';
import { resolvePermissions } from '@/lib/salao/permissions';
import { loadOpenCash } from '@/lib/salao/service';
import { supabaseAdmin } from '@/lib/payments/admin-client';

export async function GET(request: Request) {
  try {
    const resolution = await resolveActor(request);
    if (resolution.state === 'device_required') return NextResponse.json({ state: 'device_required' });

    if (resolution.state === 'pin_required') {
      const { data: account } = await supabaseAdmin()
        .from('accounts')
        .select('name')
        .eq('id', resolution.accountId)
        .maybeSingle();
      return NextResponse.json({ state: 'pin_required', account_name: account?.name ?? '' });
    }

    const ctx = await requireSalao(request);
    const cash = await loadOpenCash(ctx);
    return NextResponse.json({
      state: 'ok',
      account: ctx.account,
      actor: { name: ctx.actor.name, role: ctx.actor.role, via: ctx.actor.via },
      permissions: resolvePermissions(ctx.settings.permissions)[ctx.actor.role],
      settings: {
        service_fee_percent: ctx.settings.service_fee_percent ?? DEFAULT_SETTINGS.service_fee_percent,
        require_open_cash: ctx.settings.require_open_cash,
      },
      cash_open: !!cash,
    });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
