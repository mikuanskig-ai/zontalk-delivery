import { describe, expect, it } from 'vitest';
import { addonLabel, elapsed, money, parseMoneyInput } from './format';

describe('money', () => {
  it('mostra centavos em reais', () => {
    expect(money(12.5).replace(/\s/g, ' ')).toBe('R$ 12,50');
    expect(money(1234.5).replace(/\s/g, ' ')).toBe('R$ 1.234,50');
  });
  it('valor inválido vira zero, nunca NaN na tela', () => {
    expect(money(Number.NaN).replace(/\s/g, ' ')).toBe('R$ 0,00');
  });
});

describe('parseMoneyInput', () => {
  it.each([
    ['12,50', 12.5],
    ['12.5', 12.5],
    ['1.234,56', 1234.56],
    ['  30 ', 30],
    ['0,1', 0.1],
  ])('"%s" → %s', (raw, expected) => {
    expect(parseMoneyInput(raw)).toBe(expected);
  });
  it('vazio ou texto vira NaN', () => {
    expect(parseMoneyInput('')).toBeNaN();
    expect(parseMoneyInput('abc')).toBeNaN();
  });
});

describe('elapsed', () => {
  const now = Date.parse('2026-10-27T15:00:00Z');
  it('formata minutos e horas', () => {
    expect(elapsed('2026-10-27T14:59:40Z', now)).toBe('agora');
    expect(elapsed('2026-10-27T14:48:00Z', now)).toBe('12 min');
    expect(elapsed('2026-10-27T13:55:00Z', now)).toBe('1h05');
  });
  it('relógio do celular adiantado não gera tempo negativo', () => {
    expect(elapsed('2026-10-27T15:10:00Z', now)).toBe('agora');
  });
});

describe('addonLabel', () => {
  it('junta grupo e opção, e tolera dado incompleto', () => {
    expect(addonLabel([{ group_name: 'Carne', option_name: 'Filé' }, { option_name: 'Ovo' }, {}])).toEqual(['Carne: Filé', 'Ovo']);
  });
});
