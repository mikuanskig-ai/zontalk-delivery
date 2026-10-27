import { describe, expect, it } from 'vitest';
import type { PublicMenuProduct } from '@/lib/delivery/public-menu';
import { buildRoundLines, describeCartError, parseRequestedLines, MAX_LINES_PER_ROUND } from './cart';

const marmita: PublicMenuProduct = {
  id: 'p-marmita',
  name: 'Marmita P',
  description: null,
  price: 28,
  image_url: null,
  position: 0,
  addon_groups: [
    {
      id: 'g-carne',
      name: 'Carne',
      selection_type: 'single',
      is_required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { id: 'o-churrasco', name: 'Churrasco', price_delta: 0 },
        { id: 'o-file', name: 'Filé', price_delta: 6.5 },
      ],
    },
    {
      id: 'g-extra',
      name: 'Extras',
      selection_type: 'multiple',
      is_required: false,
      min_select: 0,
      max_select: 2,
      options: [
        { id: 'o-ovo', name: 'Ovo', price_delta: 3 },
        { id: 'o-farofa', name: 'Farofa', price_delta: 2 },
        { id: 'o-vinagrete', name: 'Vinagrete', price_delta: 1 },
      ],
    },
  ],
};

const refri: PublicMenuProduct = {
  id: 'p-refri',
  name: 'Refrigerante Lata',
  description: null,
  price: 6,
  image_url: null,
  position: 1,
  addon_groups: [],
};

const menu = [marmita, refri];

describe('parseRequestedLines', () => {
  it('normaliza quantidade, ids repetidos e observação', () => {
    expect(
      parseRequestedLines([
        { product_id: 'a', quantity: '3', addon_option_ids: ['x', 'x', 5, 'y'], notes: '  sem cebola  ' },
        { product_id: 'b' },
      ]),
    ).toEqual([
      { product_id: 'a', quantity: 3, addon_option_ids: ['x', 'y'], notes: 'sem cebola' },
      { product_id: 'b', quantity: 1, addon_option_ids: [], notes: null },
    ]);
  });

  it('limita a quantidade', () => {
    expect(parseRequestedLines([{ product_id: 'a', quantity: 5000 }])![0].quantity).toBe(99);
    expect(parseRequestedLines([{ product_id: 'a', quantity: -4 }])![0].quantity).toBe(1);
  });

  it('rejeita forma errada', () => {
    expect(parseRequestedLines(null)).toBeNull();
    expect(parseRequestedLines([])).toBeNull();
    expect(parseRequestedLines([{ quantity: 1 }])).toBeNull();
    expect(parseRequestedLines(['x'])).toBeNull();
  });
});

describe('buildRoundLines', () => {
  it('calcula o preço no servidor, com adicionais e quantidade', () => {
    const result = buildRoundLines(menu, [
      { product_id: 'p-marmita', quantity: 2, addon_option_ids: ['o-file', 'o-ovo'], notes: null },
      { product_id: 'p-refri', quantity: 3, addon_option_ids: [], notes: 'gelada' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0].line_total).toBe((28 + 6.5 + 3) * 2);
    expect(result.lines[0].addons_snapshot.map((a) => a.option_name)).toEqual(['Filé', 'Ovo']);
    expect(result.lines[1]).toMatchObject({ unit_price: 6, line_total: 18, notes: 'gelada' });
  });

  it('arredonda para centavos (sem resto de ponto flutuante)', () => {
    const odd: PublicMenuProduct = {
      ...refri,
      id: 'p-odd',
      price: 0.1,
      addon_groups: [
        { id: 'g', name: 'Extra', selection_type: 'single', is_required: false, min_select: 0, max_select: 1, options: [
          { id: 'o', name: 'Molho', price_delta: 0.2 },
        ] },
      ],
    };
    const result = buildRoundLines([odd], [{ product_id: 'p-odd', quantity: 1, addon_option_ids: ['o'], notes: null }]);
    expect(result.ok && result.lines[0].line_total).toBe(0.3);
  });

  it('recusa produto que não está no cardápio (inativo ou inventado)', () => {
    const result = buildRoundLines(menu, [{ product_id: 'nao-existe', quantity: 1, addon_option_ids: [], notes: null }]);
    expect(result).toEqual({ ok: false, error: { code: 'unknown_product', product_id: 'nao-existe' } });
  });

  it('recusa adicional que não pertence ao produto', () => {
    const result = buildRoundLines(menu, [{ product_id: 'p-refri', quantity: 1, addon_option_ids: ['o-ovo'], notes: null }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_addon');
  });

  it('exige o grupo obrigatório', () => {
    const result = buildRoundLines(menu, [{ product_id: 'p-marmita', quantity: 1, addon_option_ids: [], notes: null }]);
    expect(result).toMatchObject({ ok: false, error: { code: 'addon_group_invalid', group_name: 'Carne', reason: 'required' } });
  });

  it('recusa duas opções num grupo de escolha única', () => {
    const result = buildRoundLines(menu, [
      { product_id: 'p-marmita', quantity: 1, addon_option_ids: ['o-churrasco', 'o-file'], notes: null },
    ]);
    expect(result).toMatchObject({ ok: false, error: { reason: 'single' } });
  });

  it('respeita o máximo de um grupo de múltipla escolha', () => {
    const result = buildRoundLines(menu, [
      { product_id: 'p-marmita', quantity: 1, addon_option_ids: ['o-churrasco', 'o-ovo', 'o-farofa', 'o-vinagrete'], notes: null },
    ]);
    expect(result).toMatchObject({ ok: false, error: { reason: 'max', group_name: 'Extras' } });
  });

  it('grupo opcional pode ficar vazio', () => {
    const result = buildRoundLines(menu, [{ product_id: 'p-marmita', quantity: 1, addon_option_ids: ['o-churrasco'], notes: null }]);
    expect(result.ok).toBe(true);
  });

  it('exige o mínimo de um grupo opcional que tem mínimo', () => {
    const picky: PublicMenuProduct = {
      ...refri,
      id: 'p-picky',
      addon_groups: [
        { id: 'g', name: 'Sabores', selection_type: 'multiple', is_required: false, min_select: 2, max_select: 3, options: [
          { id: 'a', name: 'A', price_delta: 0 }, { id: 'b', name: 'B', price_delta: 0 }, { id: 'c', name: 'C', price_delta: 0 },
        ] },
      ],
    };
    const result = buildRoundLines([picky], [{ product_id: 'p-picky', quantity: 1, addon_option_ids: ['a'], notes: null }]);
    expect(result).toMatchObject({ ok: false, error: { reason: 'min' } });
  });

  it('limita o tamanho de uma rodada', () => {
    const many = Array.from({ length: MAX_LINES_PER_ROUND + 1 }, () => ({
      product_id: 'p-refri', quantity: 1, addon_option_ids: [], notes: null,
    }));
    expect(buildRoundLines(menu, many)).toEqual({ ok: false, error: { code: 'too_many_lines' } });
  });

  it('as mensagens de erro são em português e não vazam ids', () => {
    const msg = describeCartError({ code: 'addon_group_invalid', product_name: 'Marmita P', group_name: 'Carne', reason: 'required' });
    expect(msg).toBe('Marmita P: escolha uma opção em "Carne".');
    expect(describeCartError({ code: 'unknown_product', product_id: 'abc-123' })).not.toContain('abc-123');
  });
});
