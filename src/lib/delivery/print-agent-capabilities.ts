// ============================================================
// O que o Print Agent que está consultando a fila sabe imprimir.
//
// O agente informa na consulta (GET /api/v1/print-jobs):
//   ?agent=1.5.0&printers=cozinha,caixa
// Um agente antigo (<= 1.4.x) não manda nada — e por isso só recebe
// pedido de delivery para a impressora da cozinha, exatamente como
// antes do módulo Salão. Um ticket de salão nunca pode ir parar num
// agente que não sabe imprimi-lo (ele o marcaria como falho e gastaria
// as 3 tentativas).
// ============================================================

export const PRINT_KINDS = ['delivery_order', 'salao_round', 'salao_item_cancel', 'salao_bill', 'cash_report'] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

export const PRINT_TARGETS = ['cozinha', 'caixa'] as const;
export type PrintTarget = (typeof PRINT_TARGETS)[number];

/** A partir desta versão o agente entende os tickets do salão. */
export const SALAO_MIN_AGENT_VERSION = '1.5.0';

export interface AgentCapabilities {
  kinds: PrintKind[];
  targets: PrintTarget[];
  version: string | null;
  hasCaixaPrinter: boolean;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export function parseAgentCapabilities(params: URLSearchParams): AgentCapabilities {
  const version = params.get('agent');
  if (!isVersionAtLeast(version, SALAO_MIN_AGENT_VERSION)) {
    return { kinds: ['delivery_order'], targets: ['cozinha'], version: version ?? null, hasCaixaPrinter: false };
  }

  const declared = (params.get('printers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is PrintTarget => (PRINT_TARGETS as readonly string[]).includes(s));
  const targets: PrintTarget[] = declared.length > 0 ? [...new Set(declared)] : ['cozinha'];

  return {
    kinds: [...PRINT_KINDS],
    targets,
    version,
    hasCaixaPrinter: targets.includes('caixa'),
  };
}
