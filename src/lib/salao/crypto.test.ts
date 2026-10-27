import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPinFailures,
  isValidPairingCode,
  isValidPin,
  newDeviceToken,
  newPairingCode,
  pairingCodeHmac,
  pinHmac,
  pinLockRemainingMs,
  readCookie,
  recordPinFailure,
  resetPinStatesForTests,
  sha256Hex,
  signSession,
  verifySession,
  SESSION_TTL_S,
} from './crypto';

beforeEach(() => {
  process.env.SALAO_SECRET = 'segredo-de-teste';
  resetPinStatesForTests();
});

describe('PIN e código de pareamento', () => {
  it('aceita só PIN de 4 a 6 dígitos', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin(1234)).toBe(false);
  });

  it('o HMAC do PIN é estável e depende da conta e do PIN', () => {
    expect(pinHmac('conta-1', '1234')).toBe(pinHmac('conta-1', '1234'));
    expect(pinHmac('conta-1', '1234')).not.toBe(pinHmac('conta-2', '1234'));
    expect(pinHmac('conta-1', '1234')).not.toBe(pinHmac('conta-1', '1235'));
    expect(pinHmac('conta-1', '1234')).not.toContain('1234');
  });

  it('muda o HMAC quando muda o segredo', () => {
    const a = pinHmac('c', '1234');
    process.env.SALAO_SECRET = 'outro';
    expect(pinHmac('c', '1234')).not.toBe(a);
  });

  it('o código de pareamento tem sempre 6 dígitos', () => {
    for (let i = 0; i < 200; i++) expect(newPairingCode()).toMatch(/^\d{6}$/);
    expect(isValidPairingCode('012345')).toBe(true);
    expect(isValidPairingCode('12345')).toBe(false);
    expect(pairingCodeHmac('123456')).toBe(pairingCodeHmac('123456'));
  });

  it('o token do aparelho é longo e único, e o banco guarda só o hash', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(sha256Hex(a)).toHaveLength(64);
    expect(sha256Hex(a)).not.toContain(a);
  });
});

describe('sessão de turno', () => {
  const payload = { a: 'conta-1', d: 'aparelho-1', s: 'func-1', r: 'garcom' as const };

  it('assina e verifica', () => {
    const token = signSession(payload);
    expect(verifySession(token)).toMatchObject(payload);
  });

  it('expira depois de 12 horas', () => {
    const now = Date.now();
    const token = signSession(payload, now);
    expect(verifySession(token, now + (SESSION_TTL_S - 5) * 1000)).not.toBeNull();
    expect(verifySession(token, now + (SESSION_TTL_S + 5) * 1000)).toBeNull();
  });

  it('rejeita payload adulterado (ex.: trocar garçom por gerente)', () => {
    const token = signSession(payload);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, r: 'gerente', exp: 9999999999 })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`)).toBeNull();
    expect(verifySession(`${body}.${sig.slice(0, -2)}aa`)).toBeNull();
  });

  it('rejeita assinatura de outro segredo', () => {
    const token = signSession(payload);
    process.env.SALAO_SECRET = 'outro-segredo';
    expect(verifySession(token)).toBeNull();
  });

  it('rejeita lixo, vazio e papel inválido', () => {
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession('')).toBeNull();
    expect(verifySession('abc')).toBeNull();
    expect(verifySession('a.b')).toBeNull();
    expect(verifySession('.')).toBeNull();
    const bad = signSession({ ...payload, r: 'dono' as never });
    expect(verifySession(bad)).toBeNull();
  });
});

describe('readCookie', () => {
  it('lê o cookie certo entre vários', () => {
    const header = 'a=1; zk_salao_dev=abc%20def; b=2';
    expect(readCookie(header, 'zk_salao_dev')).toBe('abc def');
    expect(readCookie(header, 'a')).toBe('1');
    expect(readCookie(header, 'nao-existe')).toBeUndefined();
    expect(readCookie(null, 'a')).toBeUndefined();
  });

  it('não confunde prefixos de nome', () => {
    expect(readCookie('xzk_salao_dev=1', 'zk_salao_dev')).toBeUndefined();
  });
});

describe('trava de PIN', () => {
  it('trava por 1 minuto depois de 5 erros e libera depois', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordPinFailure('ap-1', t0);
    expect(pinLockRemainingMs('ap-1', t0)).toBe(0);
    recordPinFailure('ap-1', t0);
    expect(pinLockRemainingMs('ap-1', t0)).toBe(60_000);
    expect(pinLockRemainingMs('ap-1', t0 + 30_000)).toBe(30_000);
    expect(pinLockRemainingMs('ap-1', t0 + 61_000)).toBe(0);
  });

  it('um acerto zera a contagem', () => {
    const t0 = 5_000;
    for (let i = 0; i < 4; i++) recordPinFailure('ap-2', t0);
    clearPinFailures('ap-2');
    recordPinFailure('ap-2', t0);
    expect(pinLockRemainingMs('ap-2', t0)).toBe(0);
  });

  it('cada aparelho tem a sua contagem', () => {
    const t0 = 9_000;
    for (let i = 0; i < 5; i++) recordPinFailure('ap-3', t0);
    expect(pinLockRemainingMs('ap-3', t0)).toBeGreaterThan(0);
    expect(pinLockRemainingMs('ap-4', t0)).toBe(0);
  });

  it('depois que a trava vence, recomeça a contar do zero', () => {
    const t0 = 20_000;
    for (let i = 0; i < 5; i++) recordPinFailure('ap-5', t0);
    const later = t0 + 61_000;
    for (let i = 0; i < 4; i++) recordPinFailure('ap-5', later);
    expect(pinLockRemainingMs('ap-5', later)).toBe(0);
    recordPinFailure('ap-5', later);
    expect(pinLockRemainingMs('ap-5', later)).toBe(60_000);
  });
});
