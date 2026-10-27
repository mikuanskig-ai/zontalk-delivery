// GET /api/salao/menu — cardápio para o garçom escolher itens (com os
// grupos de adicionais e o preço do dia já aplicado).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { loadMenu } from '@/lib/salao/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireSalao(request, { action: 'add_items' });
    const { categories, uncategorizedProducts } = await loadMenu(ctx);
    return NextResponse.json({ categories, uncategorized: uncategorizedProducts, currency: ctx.account.currency });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
