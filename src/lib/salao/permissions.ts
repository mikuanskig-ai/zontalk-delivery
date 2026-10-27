// ============================================================
// Permissões do módulo Salão — puro, sem I/O.
//
// Uma lista FECHADA de ações e uma matriz papel → ação. O padrão mora
// aqui; cada restaurante só guarda as DIFERENÇAS em
// `salao_settings.permissions` (ex.: { garcom: { close_tab: true } }).
// Papel desconhecido ou ação desconhecida nunca é permitido.
//
// O gerente pode tudo e isso NÃO é configurável (senão o dono poderia
// se trancar para fora do próprio salão). A checagem que vale é a do
// servidor, em toda rota de /api/salao/*; a tela usa a mesma função só
// para esconder/desabilitar botões.
// ============================================================

export const SALAO_ROLES = ['garcom', 'caixa', 'gerente'] as const;
export type SalaoRole = (typeof SALAO_ROLES)[number];

export const SALAO_ACTIONS = [
  'open_tab',
  'add_items',
  'transfer_tab',
  'request_bill',
  'cancel_item',
  'apply_discount',
  'close_tab',
  'reopen_tab',
  'open_cash',
  'close_cash',
  'cash_movement',
] as const;
export type SalaoAction = (typeof SALAO_ACTIONS)[number];

/** Ações que o dono pode liberar/bloquear por papel (todas menos as
 *  fixas abaixo). */
export const CONFIGURABLE_ROLES: readonly SalaoRole[] = ['garcom', 'caixa'];

/** Só o gerente faz, e não dá para mudar. */
const MANAGER_ONLY: readonly SalaoAction[] = ['reopen_tab'];

export type PermissionOverrides = Partial<Record<SalaoRole, Partial<Record<SalaoAction, boolean>>>>;

export const DEFAULT_PERMISSIONS: Record<SalaoRole, Record<SalaoAction, boolean>> = {
  garcom: {
    open_tab: true,
    add_items: true,
    transfer_tab: true,
    request_bill: true,
    cancel_item: false,
    apply_discount: false,
    close_tab: false,
    reopen_tab: false,
    open_cash: false,
    close_cash: false,
    cash_movement: false,
  },
  caixa: {
    open_tab: true,
    add_items: true,
    transfer_tab: true,
    request_bill: true,
    cancel_item: true,
    apply_discount: true,
    close_tab: true,
    reopen_tab: false,
    open_cash: true,
    close_cash: true,
    cash_movement: true,
  },
  gerente: {
    open_tab: true,
    add_items: true,
    transfer_tab: true,
    request_bill: true,
    cancel_item: true,
    apply_discount: true,
    close_tab: true,
    reopen_tab: true,
    open_cash: true,
    close_cash: true,
    cash_movement: true,
  },
};

export const ACTION_LABELS: Record<SalaoAction, string> = {
  open_tab: 'Abrir comanda',
  add_items: 'Lançar itens',
  transfer_tab: 'Transferir ou juntar mesa',
  request_bill: 'Pedir a conta (pré-conta)',
  cancel_item: 'Cancelar item lançado',
  apply_discount: 'Dar desconto',
  close_tab: 'Fechar comanda',
  reopen_tab: 'Reabrir comanda',
  open_cash: 'Abrir o caixa',
  close_cash: 'Fechar o caixa',
  cash_movement: 'Sangria e suprimento',
};

export function isSalaoRole(value: unknown): value is SalaoRole {
  return typeof value === 'string' && (SALAO_ROLES as readonly string[]).includes(value);
}

export function isSalaoAction(value: unknown): value is SalaoAction {
  return typeof value === 'string' && (SALAO_ACTIONS as readonly string[]).includes(value);
}

/**
 * Pode `role` fazer `action`, dado o que o restaurante configurou?
 * `overrides` vem cru do banco (jsonb): qualquer coisa fora do formato
 * esperado é ignorada em vez de quebrar.
 */
export function can(role: unknown, action: unknown, overrides?: unknown): boolean {
  if (!isSalaoRole(role) || !isSalaoAction(action)) return false;
  if (role === 'gerente') return true;
  if (MANAGER_ONLY.includes(action)) return false;

  const roleOverrides = overrides && typeof overrides === 'object'
    ? (overrides as Record<string, unknown>)[role]
    : undefined;
  if (roleOverrides && typeof roleOverrides === 'object') {
    const value = (roleOverrides as Record<string, unknown>)[action];
    if (typeof value === 'boolean') return value;
  }
  return DEFAULT_PERMISSIONS[role][action];
}

/** Matriz completa já resolvida (padrão + diferenças), para a tela de
 *  configuração e para o cliente saber o que mostrar. */
export function resolvePermissions(overrides?: unknown): Record<SalaoRole, Record<SalaoAction, boolean>> {
  const result = {} as Record<SalaoRole, Record<SalaoAction, boolean>>;
  for (const role of SALAO_ROLES) {
    result[role] = {} as Record<SalaoAction, boolean>;
    for (const action of SALAO_ACTIONS) {
      result[role][action] = can(role, action, overrides);
    }
  }
  return result;
}

/**
 * Limpa o que veio da tela antes de gravar: só papéis configuráveis,
 * só ações conhecidas e não-fixas, só booleanos — e só guarda o que
 * difere do padrão (matriz enxuta, fácil de mudar o padrão depois).
 */
export function sanitizeOverrides(input: unknown): PermissionOverrides {
  const out: PermissionOverrides = {};
  if (!input || typeof input !== 'object') return out;
  for (const role of CONFIGURABLE_ROLES) {
    const raw = (input as Record<string, unknown>)[role];
    if (!raw || typeof raw !== 'object') continue;
    for (const action of SALAO_ACTIONS) {
      if (MANAGER_ONLY.includes(action)) continue;
      const value = (raw as Record<string, unknown>)[action];
      if (typeof value !== 'boolean') continue;
      if (value === DEFAULT_PERMISSIONS[role][action]) continue;
      (out[role] ??= {})[action] = value;
    }
  }
  return out;
}
