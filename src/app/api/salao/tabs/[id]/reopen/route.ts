// POST /api/salao/tabs/[id]/reopen — reabre uma comanda fechada (só
// gerente). Não reabre se o caixa em que ela foi paga já fechou.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { reopenTab } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'reopen_tab' });
    const { id } = await params;
    await reopenTab(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
