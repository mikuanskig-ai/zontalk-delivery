// ============================================================
// GET/POST /api/salao/admin/tables — mesas do restaurante (painel, admin+).
//
// POST cria várias de uma vez ({ count, start?, area? }: mesas 1..N) ou
// uma só ({ number, name?, area? }). Número repetido na conta é recusado.
// ============================================================

import { NextResponse } from 'next/server';
import { SalaoError, requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';

const MAX_TABLES_AT_ONCE = 100;
const MAX_TABLES_PER_ACCOUNT = 300;

function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

export async function GET() {
  try {
    const admin = await requireSalaoAdmin();
    const [tablesRes, openRes] = await Promise.all([
      admin.db
        .from('salao_tables')
        .select('id, number, name, area, position, is_active, qr_token, created_at')
        .eq('account_id', admin.accountId)
        .order('position')
        .order('number'),
      admin.db
        .from('salao_tabs')
        .select('table_id')
        .eq('account_id', admin.accountId)
        .in('status', ['open', 'bill_requested'])
        .not('table_id', 'is', null),
    ]);
    const busy = new Set((openRes.data ?? []).map((t) => t.table_id as string));
    return NextResponse.json({
      tables: (tablesRes.data ?? []).map((t) => ({ ...t, has_open_tab: busy.has(t.id) })),
    });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireSalaoAdmin();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SalaoError(400, 'invalid_body', 'Dados inválidos.');

    const { count: existing } = await admin.db
      .from('salao_tables')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', admin.accountId);

    const area = cleanText(body.area, 40);
    let rows: { number: number; name: string | null }[];

    if (body.count !== undefined) {
      const count = Math.trunc(Number(body.count));
      const start = Math.trunc(Number(body.start ?? 1)) || 1;
      if (!Number.isFinite(count) || count < 1 || count > MAX_TABLES_AT_ONCE) {
        throw new SalaoError(400, 'invalid_count', `Crie de 1 a ${MAX_TABLES_AT_ONCE} mesas por vez.`);
      }
      if (start < 1) throw new SalaoError(400, 'invalid_number', 'O número da mesa começa em 1.');
      rows = Array.from({ length: count }, (_, i) => ({ number: start + i, name: null }));
    } else {
      const number = Math.trunc(Number(body.number));
      if (!Number.isFinite(number) || number < 1) throw new SalaoError(400, 'invalid_number', 'Informe o número da mesa.');
      rows = [{ number, name: cleanText(body.name, 40) }];
    }

    if ((existing ?? 0) + rows.length > MAX_TABLES_PER_ACCOUNT) {
      throw new SalaoError(400, 'too_many_tables', `O limite é de ${MAX_TABLES_PER_ACCOUNT} mesas por restaurante.`);
    }

    const { data, error } = await admin.db
      .from('salao_tables')
      .insert(rows.map((r) => ({ account_id: admin.accountId, number: r.number, name: r.name, area, position: r.number })))
      .select('id, number');
    if (error) {
      if (error.code === '23505') {
        throw new SalaoError(409, 'duplicate_number', 'Já existe uma mesa com um desses números.');
      }
      console.error('[salao/admin/tables] falha ao criar:', error.message);
      throw new SalaoError(500, 'internal', 'Não foi possível criar as mesas.');
    }
    return NextResponse.json({ created: data?.length ?? 0 }, { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
