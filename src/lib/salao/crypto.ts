// ============================================================
// Criptografia do acesso do Salão — puro (sem banco), testável.
//
//   - PIN do funcionário e código de pareamento: HMAC-SHA256 com um
//     segredo do servidor. Determinístico de propósito (dá para exigir
//     PIN único por conta e achar o funcionário pelo PIN), mas um
//     vazamento só do banco não permite adivinhar PINs de 4-6 dígitos.
//   - Token do aparelho: aleatório de 256 bits; o banco guarda só o
//     SHA-256 dele.
//   - Sessão de turno (PIN já digitado): cookie assinado
//     `<payload base64url>.<HMAC>` com validade embutida. Sem estado no
//     servidor; quem some (funcionário desativado, aparelho revogado) é
//     barrado porque a rota confere o banco a cada chamada.
// ============================================================

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isSalaoRole, type SalaoRole } from './permissions';

export const DEVICE_COOKIE = 'zk_salao_dev';
export const SESSION_COOKIE = 'zk_salao_sess';
export const DEVICE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
export const SESSION_TTL_S = 12 * 60 * 60;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Segredo do servidor. Usa SALAO_SECRET se existir; senão deriva da
 * chave de serviço do Supabase (que já é secreta e só o servidor tem),
 * para o módulo funcionar sem mexer no ambiente.
 */
function secret(): string {
  const value = process.env.SALAO_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('SALAO_SECRET/SUPABASE_SERVICE_ROLE_KEY not configured');
  return `zk-salao:${value}`;
}

export function hmacHex(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 6 dígitos, com zeros à esquerda. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

export function isValidPairingCode(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

export function pinHmac(accountId: string, pin: string): string {
  return hmacHex(`pin:${accountId}:${pin}`);
}

export function pairingCodeHmac(code: string): string {
  return hmacHex(`pair:${code}`);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------
// Sessão de turno
// ------------------------------------------------------------

export interface SessionPayload {
  /** conta */
  a: string;
  /** aparelho */
  d: string;
  /** funcionário */
  s: string;
  /** papel no momento do login (a rota confere de novo no banco) */
  r: SalaoRole;
  /** expira em (epoch s) */
  exp: number;
}

export function signSession(payload: Omit<SessionPayload, 'exp'>, nowMs: number = Date.now()): string {
  const full: SessionPayload = { ...payload, exp: Math.floor(nowMs / 1000) + SESSION_TTL_S };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${hmacHex(`sess:${body}`)}`;
}

export function verifySession(token: string | undefined | null, nowMs: number = Date.now()): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmacHex(`sess:${body}`))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (
      typeof parsed.a !== 'string' ||
      typeof parsed.d !== 'string' ||
      typeof parsed.s !== 'string' ||
      !isSalaoRole(parsed.r) ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (parsed.exp * 1000 <= nowMs) return null;
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Cookies (lê do cabeçalho cru, igual em rota e em teste)
// ------------------------------------------------------------

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------
// Trava de PIN: 5 erros seguidos bloqueiam o aparelho por 1 minuto.
// Em memória (uma instância do servidor) — suficiente para o objetivo,
// que é impedir adivinhar PIN de 4-6 dígitos na sequência.
// ------------------------------------------------------------

const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60_000;

interface PinState {
  failures: number;
  lockedUntil: number;
}

const pinStates = new Map<string, PinState>();

export function pinLockRemainingMs(deviceId: string, nowMs: number = Date.now()): number {
  const state = pinStates.get(deviceId);
  if (!state || state.lockedUntil <= nowMs) return 0;
  return state.lockedUntil - nowMs;
}

export function recordPinFailure(deviceId: string, nowMs: number = Date.now()): void {
  const state = pinStates.get(deviceId) ?? { failures: 0, lockedUntil: 0 };
  // Uma trava que já venceu zera a contagem.
  if (state.lockedUntil && state.lockedUntil <= nowMs) {
    state.failures = 0;
    state.lockedUntil = 0;
  }
  state.failures += 1;
  if (state.failures >= PIN_MAX_FAILURES) {
    state.lockedUntil = nowMs + PIN_LOCK_MS;
    state.failures = 0;
  }
  pinStates.set(deviceId, state);
}

export function clearPinFailures(deviceId: string): void {
  pinStates.delete(deviceId);
}

/** Só para testes. */
export function resetPinStatesForTests(): void {
  pinStates.clear();
}
