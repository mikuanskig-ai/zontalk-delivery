// POST /api/salao/tabs/[id]/rounds — lança itens na comanda e manda o
// ticket para a impressora da cozinha. O celular manda só ids e
// quantidades; o preço é sempre recalculado aqui.

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { addRound } from '@/lib/salao/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSalao(request, { action: 'add_items' });
    const { id } = await params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await addRound(ctx, id, body?.items), { status: 201 });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
