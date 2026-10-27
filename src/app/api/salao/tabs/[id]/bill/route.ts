// POST /api/salao/tabs/[id]/bill — pede a conta: a mesa fica amarela e a
// pré-conta sai na impressora do caixa. Pode ser repetido (reimprime).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { requestBill } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'request_bill' });
    const { id } = await params;
    return NextResponse.json(await requestBill(ctx, id));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
