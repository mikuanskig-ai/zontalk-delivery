// GET /api/salao/floor — o mapa do salão: cada mesa com a cor do estado
// (livre / aberta / conta pedida), vendas de balcão abertas, caixa e
// totais. O celular consulta a cada ~4 s (os aparelhos do salão não têm
// sessão do Supabase, então não dá para usar o realtime com RLS).

import { NextResponse } from 'next/server';
import { requireSalao, salaoErrorResponse } from '@/lib/salao/context';
import { loadFloor } from '@/lib/salao/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireSalao(request);
    return NextResponse.json(await loadFloor(ctx));
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
