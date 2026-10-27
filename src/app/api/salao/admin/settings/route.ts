// ============================================================
// GET/PUT /api/salao/admin/settings — configurações do salão (painel,
// admin+): taxa de serviço, exigir caixa aberto e a matriz de
// permissões por papel (o que o garçom e o caixa podem fazer).
// ============================================================

import { NextResponse } from 'next/server';
import { SalaoError, invalidateSalaoSnapshot, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';
import {
  ACTION_LABELS,
  CONFIGURABLE_ROLES,
  SALAO_ACTIONS,
  SALAO_ROLES,
  resolvePermissions,
  sanitizeOverrides,
} from '@/lib/salao/permissions';

async function snapshot(db: Awaited<ReturnType<typeof requireSalaoAdmin>>['db'], accountId: string) {
  const [{ data: row }, { data: printConfig }] = await Promise.all([
    db
      .from('salao_settings')
      .select('service_fee_percent, service_fee_default_on, require_open_cash, permissions')
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('print_configs')
      .select('enabled, last_polled_at, last_polled_caixa_at')
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);
  return {
    settings: {
      service_fee_percent: row ? Number(row.service_fee_percent) : 10,
      service_fee_default_on: row?.service_fee_default_on ?? true,
      require_open_cash: row?.require_open_cash ?? true,
    },
    permissions: resolvePermissions(row?.permissions ?? {}),
    meta: {
      roles: SALAO_ROLES,
      configurable_roles: CONFIGURABLE_ROLES,
      actions: SALAO_ACTIONS.map((key) => ({ key, label: ACTION_LABELS[key] })),
    },
    printing: {
      enabled: printConfig?.enabled ?? false,
      last_polled_at: printConfig?.last_polled_at ?? null,
      last_polled_caixa_at: printConfig?.last_polled_caixa_at ?? null,
    },
  };
}

export async function GET() {
  try {
    const admin = await requireSalaoAdmin();
    return NextResponse.json(await snapshot(admin.db, admin.accountId));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const admin = await requireSalaoAdmin();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SalaoError(400, 'invalid_body', 'Dados inválidos.');

    const percent = Number(body.service_fee_percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new SalaoError(400, 'invalid_fee', 'A taxa de serviço deve ficar entre 0 e 100%.');
    }

    const { error } = await admin.db.from('salao_settings').upsert(
      {
        account_id: admin.accountId,
        service_fee_percent: Math.round(percent * 100) / 100,
        service_fee_default_on: body.service_fee_default_on !== false,
        require_open_cash: body.require_open_cash !== false,
        permissions: sanitizeOverrides(body.permissions),
      },
      { onConflict: 'account_id' },
    );
    if (error) {
      console.error('[salao/admin/settings] falha ao salvar:', error.message);
      throw new SalaoError(500, 'internal', 'Não foi possível salvar. Tente de novo.');
    }
    invalidateSalaoSnapshot(admin.accountId);
    return NextResponse.json(await snapshot(admin.db, admin.accountId));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
