// ============================================================
// Quem está chamando uma rota /api/salao/* e o que ele pode fazer.
//
// Dois jeitos de entrar:
//   1. Aparelho conectado + PIN (garçom, caixa, gerente cadastrados):
//      cookie do aparelho (token aleatório, só o hash fica no banco) +
//      cookie de sessão de turno (assinado, 12 h) emitido ao digitar o
//      PIN. Funcionário desativado ou aparelho revogado são barrados a
//      cada chamada, porque a rota confere o banco, não só o cookie.
//   2. Dono/admin logado no painel do Z-Delivery: entra como gerente,
//      sem PIN (o caixa pode ficar no PC do dono).
//
// A conta é SEMPRE a do aparelho/painel — nunca um id vindo do corpo da
// requisição. Toda query das rotas filtra por `ctx.accountId`.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { getCurrentAccount } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { hasModule } from '@/lib/accounts/modules';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_S,
  SESSION_COOKIE,
  SESSION_TTL_S,
  readCookie,
  sha256Hex,
  verifySession,
} from './crypto';
import { can, isSalaoRole, type SalaoAction, type SalaoRole } from './permissions';

export interface SalaoActor {
  accountId: string;
  role: SalaoRole;
  staffId: string | null;
  name: string;
  deviceId: string | null;
  via: 'device' | 'panel';
}

export interface SalaoSettings {
  service_fee_percent: number;
  service_fee_default_on: boolean;
  require_open_cash: boolean;
  permissions: unknown;
}

export const DEFAULT_SETTINGS: SalaoSettings = {
  service_fee_percent: 10,
  service_fee_default_on: true,
  require_open_cash: true,
  permissions: {},
};

export interface SalaoContext {
  actor: SalaoActor;
  accountId: string;
  db: SupabaseClient;
  settings: SalaoSettings;
  account: { name: string; currency: string; slug: string | null };
}

/** Erro de regra de negócio/autorização com status e código estáveis. */
export class SalaoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SalaoError';
  }
}

export function salaoErrorResponse(err: unknown): NextResponse {
  if (err instanceof SalaoError) {
    return NextResponse.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, { status: err.status });
  }
  console.error('[salao] erro inesperado:', err);
  return NextResponse.json({ error: 'internal', message: 'Algo deu errado. Tente de novo.' }, { status: 500 });
}

// ------------------------------------------------------------
// Conta + configurações (cache curto: o celular consulta a cada ~4 s)
// ------------------------------------------------------------

interface AccountSnapshot {
  at: number;
  enabled: boolean;
  name: string;
  currency: string;
  slug: string | null;
  settings: SalaoSettings;
}

const SNAPSHOT_TTL_MS = 20_000;
const snapshots = new Map<string, AccountSnapshot>();

export function invalidateSalaoSnapshot(accountId: string): void {
  snapshots.delete(accountId);
}

async function loadSnapshot(db: SupabaseClient, accountId: string): Promise<AccountSnapshot> {
  const cached = snapshots.get(accountId);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;

  const [accountRes, settingsRes] = await Promise.all([
    db
      .from('accounts')
      .select('name, default_currency, slug, enabled_modules, status')
      .eq('id', accountId)
      .maybeSingle(),
    db
      .from('salao_settings')
      .select('service_fee_percent, service_fee_default_on, require_open_cash, permissions')
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);

  const account = accountRes.data;
  const s = settingsRes.data;
  const snapshot: AccountSnapshot = {
    at: Date.now(),
    enabled: !!account && account.status !== 'suspended' && hasModule(account, 'salao'),
    name: account?.name ?? '',
    currency: account?.default_currency ?? 'BRL',
    slug: account?.slug ?? null,
    settings: s
      ? {
          service_fee_percent: Number(s.service_fee_percent),
          service_fee_default_on: s.service_fee_default_on,
          require_open_cash: s.require_open_cash,
          permissions: s.permissions ?? {},
        }
      : DEFAULT_SETTINGS,
  };
  snapshots.set(accountId, snapshot);
  return snapshot;
}

// ------------------------------------------------------------
// Resolução do chamador
// ------------------------------------------------------------

export type ActorResolution =
  | { state: 'ok'; actor: SalaoActor }
  | { state: 'pin_required'; deviceId: string; accountId: string }
  | { state: 'device_required' };

const DEVICE_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

async function resolveDevice(
  db: SupabaseClient,
  token: string | undefined,
): Promise<{ id: string; accountId: string } | null> {
  if (!token) return null;
  const { data } = await db
    .from('salao_devices')
    .select('id, account_id, revoked_at, last_seen_at')
    .eq('token_hash', sha256Hex(token))
    .maybeSingle();
  if (!data || data.revoked_at) return null;

  const lastSeen = data.last_seen_at ? new Date(data.last_seen_at).getTime() : 0;
  if (Date.now() - lastSeen > DEVICE_TOUCH_INTERVAL_MS) {
    void db
      .from('salao_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => undefined);
  }
  return { id: data.id, accountId: data.account_id };
}

export async function resolveActor(request: Request): Promise<ActorResolution> {
  const db = supabaseAdmin();
  const cookieHeader = request.headers.get('cookie');
  const device = await resolveDevice(db, readCookie(cookieHeader, DEVICE_COOKIE));

  if (device) {
    const session = verifySession(readCookie(cookieHeader, SESSION_COOKIE));
    if (session && session.d === device.id && session.a === device.accountId) {
      // O papel e o "ativo" valem pelo banco de agora, não pelo cookie.
      const { data: staff } = await db
        .from('salao_staff')
        .select('id, name, role, is_active')
        .eq('id', session.s)
        .eq('account_id', device.accountId)
        .maybeSingle();
      if (staff && staff.is_active && isSalaoRole(staff.role)) {
        return {
          state: 'ok',
          actor: {
            accountId: device.accountId,
            role: staff.role,
            staffId: staff.id,
            name: staff.name,
            deviceId: device.id,
            via: 'device',
          },
        };
      }
    }
  }

  // Dono/admin logado no painel entra como gerente.
  try {
    const panel = await getCurrentAccount();
    if (hasMinRole(panel.role, 'admin')) {
      const { data: profile } = await panel.supabase
        .from('profiles')
        .select('full_name')
        .eq('user_id', panel.userId)
        .maybeSingle();
      return {
        state: 'ok',
        actor: {
          accountId: panel.accountId,
          role: 'gerente',
          staffId: null,
          name: profile?.full_name?.trim() || 'Gerente',
          deviceId: null,
          via: 'panel',
        },
      };
    }
  } catch {
    // sem sessão de painel — segue
  }

  if (device) return { state: 'pin_required', deviceId: device.id, accountId: device.accountId };
  return { state: 'device_required' };
}

export interface RequireOptions {
  /** Ação que o chamador precisa poder fazer (checada com a matriz do restaurante). */
  action?: SalaoAction;
}

/**
 * Porta de entrada de toda rota autenticada do Salão. Lança SalaoError
 * (traduzido por salaoErrorResponse) em vez de devolver "meio logado".
 */
export async function requireSalao(request: Request, opts: RequireOptions = {}): Promise<SalaoContext> {
  const resolution = await resolveActor(request);
  if (resolution.state === 'device_required') {
    throw new SalaoError(401, 'device_required', 'Este aparelho ainda não foi conectado ao salão.');
  }
  if (resolution.state === 'pin_required') {
    throw new SalaoError(401, 'pin_required', 'Digite seu PIN para continuar.');
  }

  const { actor } = resolution;
  const limit = checkRateLimit(`salao:${actor.accountId}:${actor.deviceId ?? actor.staffId ?? actor.name}`, {
    limit: 240,
    windowMs: 60_000,
  });
  if (!limit.success) throw new SalaoError(429, 'rate_limited', 'Muitas chamadas seguidas. Aguarde um instante.');

  const db = supabaseAdmin();
  const snapshot = await loadSnapshot(db, actor.accountId);
  if (!snapshot.enabled) {
    throw new SalaoError(403, 'module_disabled', 'O módulo Salão não está ligado nesta conta.');
  }

  if (opts.action && !can(actor.role, opts.action, snapshot.settings.permissions)) {
    throw new SalaoError(403, 'forbidden', 'Seu usuário não tem permissão para fazer isso.', { action: opts.action });
  }

  return {
    actor,
    accountId: actor.accountId,
    db,
    settings: snapshot.settings,
    account: { name: snapshot.name, currency: snapshot.currency, slug: snapshot.slug },
  };
}

/** Rotas do dono/admin no painel (configurar mesas, equipe, aparelhos...). */
export async function requireSalaoAdmin(): Promise<{
  db: SupabaseClient;
  accountId: string;
  userId: string;
  settings: SalaoSettings;
  account: { name: string; currency: string; slug: string | null };
}> {
  let panel;
  try {
    panel = await getCurrentAccount();
  } catch {
    throw new SalaoError(401, 'unauthorized', 'Entre no painel para continuar.');
  }
  if (!hasMinRole(panel.role, 'admin')) {
    throw new SalaoError(403, 'forbidden', 'Só administradores podem configurar o salão.');
  }
  const db = supabaseAdmin();
  const snapshot = await loadSnapshot(db, panel.accountId);
  if (!snapshot.enabled) {
    throw new SalaoError(403, 'module_disabled', 'Ligue o módulo Salão em Configurações > Módulos.');
  }
  return {
    db,
    accountId: panel.accountId,
    userId: panel.userId,
    settings: snapshot.settings,
    account: { name: snapshot.name, currency: snapshot.currency, slug: snapshot.slug },
  };
}

// ------------------------------------------------------------
// Cookies de resposta
// ------------------------------------------------------------

const isProd = process.env.NODE_ENV === 'production';

export function setDeviceCookie(res: NextResponse, token: string): void {
  res.cookies.set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE_S,
  });
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: 0 });
}

export function rateLimited(result: ReturnType<typeof checkRateLimit>): NextResponse {
  return rateLimitResponse(result);
}

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

/** Traduz o erro de uma função SQL do módulo (RAISE EXCEPTION 'codigo') em SalaoError. */
export function sqlErrorToSalaoError(message: string | undefined): SalaoError {
  const code = (message ?? '').replace(/^[\s\S]*?(tab_not_found|tab_not_open|no_items|item_not_found|item_already_cancelled|table_not_found|same_table|payments_mismatch|session_not_found|session_not_open|invalid_counted|tab_not_closed|cash_session_closed|table_busy)[\s\S]*$/, '$1');
  switch (code) {
    case 'tab_not_found':
      return new SalaoError(404, 'tab_not_found', 'Comanda não encontrada.');
    case 'tab_not_open':
      return new SalaoError(409, 'tab_not_open', 'Esta comanda já foi fechada. Atualize a tela.');
    case 'no_items':
      return new SalaoError(400, 'no_items', 'Escolha pelo menos um item.');
    case 'item_not_found':
      return new SalaoError(404, 'item_not_found', 'Item não encontrado.');
    case 'item_already_cancelled':
      return new SalaoError(409, 'item_already_cancelled', 'Este item já foi cancelado.');
    case 'table_not_found':
      return new SalaoError(404, 'table_not_found', 'Mesa não encontrada.');
    case 'same_table':
      return new SalaoError(400, 'same_table', 'A comanda já está nesta mesa.');
    case 'payments_mismatch':
      return new SalaoError(409, 'payments_mismatch', 'A soma dos pagamentos não bate com o total da conta.');
    case 'session_not_found':
      return new SalaoError(404, 'session_not_found', 'Caixa não encontrado.');
    case 'session_not_open':
      return new SalaoError(409, 'session_not_open', 'Este caixa já foi fechado.');
    case 'invalid_counted':
      return new SalaoError(400, 'invalid_counted', 'Informe o valor contado no caixa.');
    case 'tab_not_closed':
      return new SalaoError(409, 'tab_not_closed', 'Esta comanda não está fechada.');
    case 'cash_session_closed':
      return new SalaoError(409, 'cash_session_closed', 'O caixa em que esta comanda foi paga já foi fechado, então ela não pode ser reaberta.');
    case 'table_busy':
      return new SalaoError(409, 'table_busy', 'A mesa desta comanda já está ocupada por outra. Feche ou mude a outra antes de reabrir.');
    default:
      console.error('[salao] erro SQL inesperado:', message);
      return new SalaoError(500, 'internal', 'Algo deu errado. Tente de novo.');
  }
}
