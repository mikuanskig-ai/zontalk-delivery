import { describe, expect, it } from 'vitest';
import { isVersionAtLeast, parseAgentCapabilities } from './print-agent-capabilities';

const q = (s: string) => new URLSearchParams(s);

describe('isVersionAtLeast', () => {
  it('compara numericamente, não como texto', () => {
    expect(isVersionAtLeast('1.5.0', '1.5.0')).toBe(true);
    expect(isVersionAtLeast('1.10.0', '1.5.0')).toBe(true);
    expect(isVersionAtLeast('2.0.0', '1.5.0')).toBe(true);
    expect(isVersionAtLeast('1.4.9', '1.5.0')).toBe(false);
    expect(isVersionAtLeast('1.5.0-beta', '1.5.0')).toBe(true);
  });

  it('versão ausente ou ilegível nunca passa', () => {
    expect(isVersionAtLeast(null, '1.5.0')).toBe(false);
    expect(isVersionAtLeast('', '1.5.0')).toBe(false);
    expect(isVersionAtLeast('abc', '1.5.0')).toBe(false);
  });
});

describe('parseAgentCapabilities', () => {
  it('agente antigo (sem parâmetros): só delivery e só cozinha', () => {
    expect(parseAgentCapabilities(q(''))).toMatchObject({
      kinds: ['delivery_order'],
      targets: ['cozinha'],
      hasCaixaPrinter: false,
    });
  });

  it('agente 1.4.0 que mande printers mesmo assim continua só com delivery na cozinha', () => {
    const caps = parseAgentCapabilities(q('agent=1.4.0&printers=cozinha,caixa'));
    expect(caps.kinds).toEqual(['delivery_order']);
    expect(caps.targets).toEqual(['cozinha']);
    expect(caps.hasCaixaPrinter).toBe(false);
  });

  it('agente 1.5.0 com as duas impressoras recebe tudo', () => {
    const caps = parseAgentCapabilities(q('agent=1.5.0&printers=cozinha,caixa'));
    expect(caps.kinds).toContain('salao_round');
    expect(caps.kinds).toContain('cash_report');
    expect(caps.targets).toEqual(['cozinha', 'caixa']);
    expect(caps.hasCaixaPrinter).toBe(true);
  });

  it('agente só da cozinha não recebe o que é do caixa', () => {
    const caps = parseAgentCapabilities(q('agent=1.5.0&printers=cozinha'));
    expect(caps.targets).toEqual(['cozinha']);
    expect(caps.hasCaixaPrinter).toBe(false);
  });

  it('agente só do caixa recebe só o que é do caixa', () => {
    const caps = parseAgentCapabilities(q('agent=1.5.0&printers=caixa'));
    expect(caps.targets).toEqual(['caixa']);
  });

  it('impressora desconhecida é ignorada; sem nenhuma válida, assume a cozinha', () => {
    expect(parseAgentCapabilities(q('agent=1.5.0&printers=bar')).targets).toEqual(['cozinha']);
    expect(parseAgentCapabilities(q('agent=1.5.0')).targets).toEqual(['cozinha']);
    expect(parseAgentCapabilities(q('agent=1.5.0&printers=caixa,caixa,bar')).targets).toEqual(['caixa']);
  });
});
