// GET   /api/salao/tabs/[id] — comanda completa (rodadas, itens, pagamentos).
// PATCH /api/salao/tabs/[id] — pessoas, nome do cliente, taxa de serviço, desconto.

import { NextResponse } from 'next/server';
import { SalaoError, requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { can } from '@/lib/salao/permissions';
import { loadTabDetail, updateTab } from '@/lib/salao/service';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request);
    const { id } = await params;
    return NextResponse.json(await loadTabDetail(ctx, id));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'add_items' });
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SalaoError(400, 'invalid_body', 'Dados inválidos.');

    // Desconto e tirar a taxa de serviço mexem no que o cliente paga:
    // pedem a permissão de desconto, não a de lançar item.
    const changesPrice = body.discount_amount !== undefined || body.service_fee_enabled === false;
    if (changesPrice && !can(ctx.actor.role, 'apply_discount', ctx.settings.permissions)) {
      throw new SalaoError(403, 'forbidden', 'Seu usuário não tem permissão para dar desconto.', { action: 'apply_discount' });
    }

    const tab = await updateTab(ctx, id, {
      guests: body.guests !== undefined ? Number(body.guests) : undefined,
      customer_name:
        body.customer_name !== undefined ? (typeof body.customer_name === 'string' ? body.customer_name : null) : undefined,
      service_fee_enabled: typeof body.service_fee_enabled === 'boolean' ? body.service_fee_enabled : undefined,
      discount_amount: body.discount_amount !== undefined ? Number(body.discount_amount) : undefined,
    });
    return NextResponse.json({ tab });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
