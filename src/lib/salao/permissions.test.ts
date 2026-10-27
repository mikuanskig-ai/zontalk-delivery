import { describe, expect, it } from 'vitest';
import {
  can,
  resolvePermissions,
  sanitizeOverrides,
  SALAO_ACTIONS,
  SALAO_ROLES,
  DEFAULT_PERMISSIONS,
} from './permissions';

describe('can — padrões', () => {
  it('garçom lança itens mas não fecha comanda nem cancela item', () => {
    expect(can('garcom', 'add_items')).toBe(true);
    expect(can('garcom', 'open_tab')).toBe(true);
    expect(can('garcom', 'close_tab')).toBe(false);
    expect(can('garcom', 'cancel_item')).toBe(false);
    expect(can('garcom', 'open_cash')).toBe(false);
  });

  it('caixa fecha comanda, cancela item e opera o caixa, mas não reabre comanda', () => {
    expect(can('caixa', 'close_tab')).toBe(true);
    expect(can('caixa', 'cancel_item')).toBe(true);
    expect(can('caixa', 'open_cash')).toBe(true);
    expect(can('caixa', 'cash_movement')).toBe(true);
    expect(can('caixa', 'reopen_tab')).toBe(false);
  });

  it('gerente pode tudo', () => {
    for (const action of SALAO_ACTIONS) expect(can('gerente', action)).toBe(true);
  });

  it('papel ou ação desconhecidos nunca são permitidos', () => {
    expect(can('dono', 'close_tab')).toBe(false);
    expect(can('garcom', 'apagar_banco')).toBe(false);
    expect(can(undefined, undefined)).toBe(false);
    expect(can(null, 'close_tab')).toBe(false);
  });
});

describe('can — configuração do restaurante', () => {
  it('o dono pode liberar o fechamento de comanda para o garçom', () => {
    const overrides = { garcom: { close_tab: true } };
    expect(can('garcom', 'close_tab', overrides)).toBe(true);
    expect(can('garcom', 'cancel_item', overrides)).toBe(false);
  });

  it('o dono pode tirar do caixa uma ação que vem liberada', () => {
    expect(can('caixa', 'apply_discount', { caixa: { apply_discount: false } })).toBe(false);
  });

  it('reabrir comanda continua só do gerente, mesmo com configuração tentando liberar', () => {
    expect(can('caixa', 'reopen_tab', { caixa: { reopen_tab: true } })).toBe(false);
    expect(can('garcom', 'reopen_tab', { garcom: { reopen_tab: true } })).toBe(false);
  });

  it('a configuração não consegue tirar nada do gerente', () => {
    expect(can('gerente', 'close_tab', { gerente: { close_tab: false } })).toBe(true);
  });

  it('configuração malformada é ignorada e vale o padrão', () => {
    for (const bad of ['x', 7, [], { garcom: 'sim' }, { garcom: { close_tab: 'true' } }, null]) {
      expect(can('garcom', 'close_tab', bad)).toBe(false);
      expect(can('caixa', 'close_tab', bad)).toBe(true);
    }
  });
});

describe('resolvePermissions', () => {
  it('sem configuração devolve exatamente o padrão', () => {
    expect(resolvePermissions()).toEqual(DEFAULT_PERMISSIONS);
  });

  it('aplica as diferenças por cima do padrão', () => {
    const resolved = resolvePermissions({ garcom: { close_tab: true } });
    expect(resolved.garcom.close_tab).toBe(true);
    expect(resolved.garcom.add_items).toBe(true);
    expect(resolved.caixa.close_tab).toBe(true);
  });
});

describe('sanitizeOverrides', () => {
  it('guarda só o que difere do padrão', () => {
    expect(
      sanitizeOverrides({ garcom: { close_tab: true, add_items: true }, caixa: { close_tab: true } }),
    ).toEqual({ garcom: { close_tab: true } });
  });

  it('descarta gerente, ações fixas, ações desconhecidas e valores que não são booleanos', () => {
    expect(
      sanitizeOverrides({
        gerente: { close_tab: false },
        garcom: { reopen_tab: true, hack: true, close_tab: 'sim' },
        caixa: { apply_discount: false },
      }),
    ).toEqual({ caixa: { apply_discount: false } });
  });

  it('entrada que não é objeto vira vazio', () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides('x')).toEqual({});
  });

  it('o resultado, aplicado, bate com o que foi pedido', () => {
    const wanted = { garcom: { close_tab: true, cancel_item: true }, caixa: { apply_discount: false } };
    const saved = sanitizeOverrides(wanted);
    for (const role of SALAO_ROLES) {
      for (const action of SALAO_ACTIONS) {
        const asked = (wanted as Record<string, Record<string, boolean>>)[role]?.[action];
        if (typeof asked === 'boolean' && role !== 'gerente') {
          expect(can(role, action, saved)).toBe(asked);
        }
      }
    }
  });
});
