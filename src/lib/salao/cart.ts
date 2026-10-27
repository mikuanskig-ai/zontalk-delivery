// ============================================================
// Monta e valida os itens de uma rodada do Salão — puro, sem I/O.
//
// O celular manda só `product_id` / `addon_option_ids` / `quantity` /
// `notes`; NUNCA preço. Todo preço vem do cardápio recarregado no
// servidor (loadPublicMenu, que já aplica o preço do dia), exatamente
// como o pedido público e a IA fazem ("nunca confie num id ou preço
// vindo de quem chama").
//
// Diferente do pedido público, aqui também se valida a regra dos grupos
// de adicionais (obrigatório / mínimo / máximo / escolha única): o
// garçom está no balcão de um restaurante de verdade e um item sem o
// "ponto da carne" é um prato errado na cozinha.
// ============================================================

import type { PublicMenuProduct } from '@/lib/delivery/public-menu';

export const MAX_QUANTITY_PER_LINE = 99;
export const MAX_LINES_PER_ROUND = 60;
export const MAX_NOTE_LENGTH = 200;

export interface RequestedLine {
  product_id: string;
  quantity: number;
  addon_option_ids: string[];
  notes: string | null;
}

export interface RoundLine {
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addons_snapshot: {
    group_id: string;
    group_name: string;
    option_id: string;
    option_name: string;
    price_delta: number;
  }[];
  line_total: number;
  notes: string | null;
}

export type CartError =
  | { code: 'invalid_items' }
  | { code: 'too_many_lines' }
  | { code: 'unknown_product'; product_id: string }
  | { code: 'unknown_addon'; product_id: string; option_id: string }
  | { code: 'addon_group_invalid'; product_name: string; group_name: string; reason: 'required' | 'min' | 'max' | 'single' };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Normaliza o corpo vindo do celular. Retorna null se a forma estiver errada. */
export function parseRequestedLines(raw: unknown): RequestedLine[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: RequestedLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.product_id !== 'string' || !e.product_id) return null;
    const quantity = Math.max(1, Math.min(MAX_QUANTITY_PER_LINE, Math.trunc(Number(e.quantity)) || 1));
    const addonIds = Array.isArray(e.addon_option_ids)
      ? [...new Set(e.addon_option_ids.filter((v): v is string => typeof v === 'string'))]
      : [];
    const notes = typeof e.notes === 'string' && e.notes.trim() ? e.notes.trim().slice(0, MAX_NOTE_LENGTH) : null;
    lines.push({ product_id: e.product_id, quantity, addon_option_ids: addonIds, notes });
  }
  return lines;
}

export function buildRoundLines(
  products: PublicMenuProduct[],
  requested: RequestedLine[],
): { ok: true; lines: RoundLine[] } | { ok: false; error: CartError } {
  if (requested.length === 0) return { ok: false, error: { code: 'invalid_items' } };
  if (requested.length > MAX_LINES_PER_ROUND) return { ok: false, error: { code: 'too_many_lines' } };

  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: RoundLine[] = [];

  for (const req of requested) {
    const product = byId.get(req.product_id);
    if (!product) return { ok: false, error: { code: 'unknown_product', product_id: req.product_id } };

    const chosen: RoundLine['addons_snapshot'] = [];
    for (const optionId of req.addon_option_ids) {
      let found = false;
      for (const group of product.addon_groups) {
        const option = group.options.find((o) => o.id === optionId);
        if (option) {
          chosen.push({
            group_id: group.id,
            group_name: group.name,
            option_id: option.id,
            option_name: option.name,
            price_delta: option.price_delta,
          });
          found = true;
          break;
        }
      }
      if (!found) {
        return { ok: false, error: { code: 'unknown_addon', product_id: product.id, option_id: optionId } };
      }
    }

    for (const group of product.addon_groups) {
      const count = chosen.filter((c) => c.group_id === group.id).length;
      const min = group.is_required ? Math.max(1, group.min_select) : group.min_select;
      const fail = (reason: 'required' | 'min' | 'max' | 'single') => ({
        ok: false as const,
        error: {
          code: 'addon_group_invalid' as const,
          product_name: product.name,
          group_name: group.name,
          reason,
        },
      });
      if (group.is_required && count === 0) return fail('required');
      if (count < min) return fail('min');
      if (group.selection_type === 'single' && count > 1) return fail('single');
      if (group.max_select != null && count > group.max_select) return fail('max');
    }

    const addonsTotal = chosen.reduce((sum, a) => sum + a.price_delta, 0);
    lines.push({
      product_id: product.id,
      product_name: product.name,
      unit_price: product.price,
      quantity: req.quantity,
      addons_snapshot: chosen,
      line_total: round2((product.price + addonsTotal) * req.quantity),
      notes: req.notes,
    });
  }

  return { ok: true, lines };
}

/** Texto em português para o garçom, sem expor ids. */
export function describeCartError(error: CartError): string {
  switch (error.code) {
    case 'invalid_items':
      return 'Escolha pelo menos um item.';
    case 'too_many_lines':
      return `Muitos itens de uma vez (máximo ${MAX_LINES_PER_ROUND}). Envie em duas rodadas.`;
    case 'unknown_product':
      return 'Um dos itens não está mais no cardápio. Atualize a tela e tente de novo.';
    case 'unknown_addon':
      return 'Uma das opções escolhidas não existe mais. Atualize a tela e tente de novo.';
    case 'addon_group_invalid':
      switch (error.reason) {
        case 'required':
        case 'min':
          return `${error.product_name}: escolha uma opção em "${error.group_name}".`;
        case 'single':
          return `${error.product_name}: em "${error.group_name}" só dá para escolher uma opção.`;
        case 'max':
          return `${error.product_name}: escolheu opções demais em "${error.group_name}".`;
      }
  }
}
