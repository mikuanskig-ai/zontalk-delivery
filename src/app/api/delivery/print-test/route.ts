import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { finalizeDeliveryOrder, type CartLineItem, type CartLineItemAddon } from '@/lib/delivery/create-order';

// POST /api/delivery/print-test  (agent+)
//
// "Simulador de impressão" (Configurações → Delivery → Impressão →
// Testar impressão) — pedido do Eder (2026-09-07): conferir como uma
// notinha vai sair na impressora REAL da loja sem precisar criar (ou
// fingir) um pedido de verdade primeiro.
//
// Reaproveita 100% o pipeline real de pedido/impressão em vez de um
// mecanismo paralelo: cria uma `delivery_orders`/`delivery_order_items`
// de verdade (igual a um pedido manual comum) e o `print_jobs`
// correspondente — assim o agente/impressora reais são exercitados de
// ponta a ponta, exatamente como um pedido real. A diferença é
// `skipSideEffects: true` em finalizeDeliveryOrder: nunca abre
// cobrança Mercado Pago, nunca marca/dispara automação em um contato,
// nunca dispara o webhook `order.created` nem uma automação de
// "pedido criado" — nada disso pode rodar com dados inventados. O
// pedido de teste fica visível em Pedidos com nome prefixado 🧪, valor
// R$0 por padrão (a menos que o usuário digite outro), pra nunca ser
// confundido com uma venda real.
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`delivery-print-test:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'items is required and must be non-empty' }, { status: 400 });
    }

    const items: CartLineItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object' || typeof raw.product_name !== 'string' || !raw.product_name.trim()) {
        return NextResponse.json({ error: 'Each item needs a product_name' }, { status: 400 });
      }
      const unitPrice = typeof raw.unit_price === 'number' && raw.unit_price >= 0 ? raw.unit_price : 0;
      const quantity =
        typeof raw.quantity === 'number' && raw.quantity > 0 ? Math.min(20, Math.trunc(raw.quantity)) : 1;
      const rawAddons = Array.isArray(raw.addons) ? raw.addons : [];
      const addons: CartLineItemAddon[] = rawAddons
        .filter(
          (a: unknown): a is { option_name: string; group_name?: unknown; price_delta?: unknown } =>
            !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).option_name === 'string',
        )
        .map((a: { option_name: string; group_name?: unknown; price_delta?: unknown }) => ({
          group_id: 'test',
          group_name: typeof a.group_name === 'string' ? a.group_name : '',
          option_id: 'test',
          option_name: a.option_name,
          price_delta: typeof a.price_delta === 'number' ? a.price_delta : 0,
        }));

      items.push({
        product_id: '', // sem produto real por trás — vira NULL no insert, ver create-order.ts
        product_name: raw.product_name.trim(),
        unit_price: unitPrice,
        quantity,
        addons,
        notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null,
      });
    }

    // Presença de delivery_address (não um campo is_pickup separado)
    // decide DELIVERY vs RETIRADA na notinha — mesma regra que
    // place_order/receipt.ts já usam pra pedido de verdade (não existe
    // coluna is_pickup em delivery_orders), então o teste reflete
    // exatamente o comportamento real.
    const deliveryAddress =
      typeof body.delivery_address === 'string' && body.delivery_address.trim()
        ? body.delivery_address.trim()
        : null;

    const customerNameInput =
      typeof body.customer_name === 'string' && body.customer_name.trim() ? body.customer_name.trim() : null;

    const { data: accountRow } = await supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle();

    const order = await finalizeDeliveryOrder(supabase, {
      accountId,
      contactId: null,
      userId,
      source: 'manual',
      cart: items,
      deliveryFee: typeof body.delivery_fee === 'number' && body.delivery_fee >= 0 ? body.delivery_fee : 0,
      deliveryAddress,
      // 🧪 sempre presente, mesmo com um nome customizado, pra nunca
      // ser confundido com um pedido real na lista de Pedidos.
      customerName: customerNameInput ? `🧪 ${customerNameInput}` : '🧪 Simulador de Impressão',
      notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
      paymentMethod: typeof body.payment_method === 'string' && body.payment_method.trim() ? body.payment_method.trim() : null,
      paymentNotes: typeof body.payment_notes === 'string' && body.payment_notes.trim() ? body.payment_notes.trim() : null,
      currency: accountRow?.default_currency ?? 'USD',
      skipSideEffects: true,
    });

    return NextResponse.json({ order_id: order.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
