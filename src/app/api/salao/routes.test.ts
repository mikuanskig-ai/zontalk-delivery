// Testes de ponta a ponta das rotas de acesso do Salão (conectar aparelho,
// PIN) e da barreira de permissão numa rota de ação (fechar comanda), com
// o banco de mentira em memória e a criptografia de verdade.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  getCurrentAccount: vi.fn(),
  closeTab: vi.fn(),
  reopenTab: vi.fn(),
}));

vi.mock('@/lib/payments/admin-client', () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: mocks.getCurrentAccount }));
vi.mock('@/lib/salao/service', async (orig) => ({
  ...(await orig<typeof import('@/lib/salao/service')>()),
  closeTab: mocks.closeTab,
  reopenTab: mocks.reopenTab,
}));

import { DEVICE_COOKIE, SESSION_COOKIE, pairingCodeHmac, pinHmac, resetPinStatesForTests, sha256Hex, signSession } from '@/lib/salao/crypto';
import { invalidateSalaoSnapshot } from '@/lib/salao/context';
import { POST as connectPOST } from './connect/route';
import { POST as pinPOST } from './pin/route';
import { POST as closePOST } from './tabs/[id]/close/route';
import { POST as reopenPOST } from './tabs/[id]/reopen/route';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  function chain(name: string) {
    let rows = tables[name] ?? [];
    let mode: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row | null = null;
    const c: Record<string, unknown> = {
      select: () => c,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return c;
      },
      is: (col: string, val: unknown) => {
        rows = rows.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return c;
      },
      gt: (col: string, val: string) => {
        rows = rows.filter((r) => String(r[col]) > val);
        return c;
      },
      update: (p: Row) => {
        mode = 'update';
        patch = p;
        return c;
      },
      insert: (p: Row) => {
        mode = 'insert';
        inserted = { id: `new-${(tables[name] ??= []).length + 1}`, ...p };
        tables[name].push(inserted);
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => {
        if (mode === 'update') {
          for (const r of rows) Object.assign(r, patch);
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (resolve: (v: unknown) => void) => {
        if (mode === 'update') for (const r of rows) Object.assign(r, patch);
        resolve({ data: rows, error: null });
      },
    };
    return c;
  }
  return { from: (name: string) => chain(name) };
}

const ACCOUNT = 'acc-1';
const DEVICE_TOKEN = 'tok-aparelho';

function world(over: { staff?: Row[]; codes?: Row[]; modules?: string[]; permissions?: unknown } = {}) {
  return {
    accounts: [{ id: ACCOUNT, name: 'Concórdia', default_currency: 'BRL', slug: 'c', enabled_modules: over.modules ?? ['delivery', 'salao'], status: 'active' }],
    salao_settings: [{ account_id: ACCOUNT, service_fee_percent: 10, service_fee_default_on: true, require_open_cash: true, permissions: over.permissions ?? {} }],
    salao_devices: [{ id: 'dev-1', account_id: ACCOUNT, token_hash: sha256Hex(DEVICE_TOKEN), revoked_at: null, last_seen_at: new Date().toISOString() }],
    salao_staff: over.staff ?? [
      { id: 'st-g', account_id: ACCOUNT, name: 'Carlos', role: 'garcom', pin_hmac: pinHmac(ACCOUNT, '1111'), is_active: true },
      { id: 'st-c', account_id: ACCOUNT, name: 'Marta', role: 'caixa', pin_hmac: pinHmac(ACCOUNT, '2222'), is_active: true },
    ],
    salao_pairing_codes: over.codes ?? [],
  };
}

function post(url: string, body: unknown, cookies: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

const setCookies = (res: Response) => res.headers.getSetCookie();

beforeEach(() => {
  process.env.SALAO_SECRET = 'segredo-de-teste';
  mocks.supabaseAdmin.mockReset();
  mocks.getCurrentAccount.mockReset();
  mocks.getCurrentAccount.mockRejectedValue(new Error('sem painel'));
  mocks.closeTab.mockReset();
  mocks.closeTab.mockResolvedValue({ tab_id: 't', total: 10, change: 0 });
  mocks.reopenTab.mockReset();
  resetPinStatesForTests();
  invalidateSalaoSnapshot(ACCOUNT);
});

describe('POST /api/salao/connect', () => {
  const futureCode = (code: string, over: Row = {}) => ({
    id: 'pc-1', account_id: ACCOUNT, code_hmac: pairingCodeHmac(code), device_name: 'Celular do Carlos',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), used_at: null, ...over,
  });

  it('código certo: cria o aparelho e entrega o cookie (o banco só guarda o hash)', async () => {
    const w = world({ codes: [futureCode('123456')] });
    w.salao_devices = [];
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    const res = await connectPOST(post('/api/salao/connect', { code: '123456' }, {}, { 'x-forwarded-for': '10.0.0.1' }));
    expect(res.status).toBe(200);
    const cookie = setCookies(res).find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    const token = decodeURIComponent(cookie!.split(';')[0].split('=')[1]);
    expect(w.salao_devices).toHaveLength(1);
    expect(w.salao_devices[0]).toMatchObject({ account_id: ACCOUNT, name: 'Celular do Carlos', token_hash: sha256Hex(token) });
    expect(JSON.stringify(w.salao_devices)).not.toContain(token);
  });

  it('o código só vale uma vez', async () => {
    const w = world({ codes: [futureCode('123456')] });
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    expect((await connectPOST(post('/api/salao/connect', { code: '123456' }, {}, { 'x-forwarded-for': '10.0.0.2' }))).status).toBe(200);
    const again = await connectPOST(post('/api/salao/connect', { code: '123456' }, {}, { 'x-forwarded-for': '10.0.0.2' }));
    expect(again.status).toBe(404);
    expect(setCookies(again)).toHaveLength(0);
  });

  it('código vencido ou inexistente: 404 sem cookie', async () => {
    const w = world({ codes: [futureCode('123456', { expires_at: new Date(Date.now() - 1000).toISOString() })] });
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    const res = await connectPOST(post('/api/salao/connect', { code: '123456' }, {}, { 'x-forwarded-for': '10.0.0.3' }));
    expect(res.status).toBe(404);
    expect(setCookies(res)).toHaveLength(0);
    expect((await connectPOST(post('/api/salao/connect', { code: '000000' }, {}, { 'x-forwarded-for': '10.0.0.3' }))).status).toBe(404);
  });

  it('código com formato errado: 400', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    for (const bad of ['12345', 'abcdef', '', 123456, null]) {
      expect((await connectPOST(post('/api/salao/connect', { code: bad }, {}, { 'x-forwarded-for': '10.0.0.4' }))).status).toBe(400);
    }
  });

  it('limita tentativas por IP (força bruta de 6 dígitos)', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await connectPOST(post('/api/salao/connect', { code: '000000' }, {}, { 'x-forwarded-for': '10.9.9.9' }))).status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(8).every((s) => s === 429)).toBe(true);
  });

  it('módulo desligado: não conecta', async () => {
    const w = world({ codes: [futureCode('123456')], modules: ['delivery'] });
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    const res = await connectPOST(post('/api/salao/connect', { code: '123456' }, {}, { 'x-forwarded-for': '10.0.0.5' }));
    expect(res.status).toBe(403);
    expect(setCookies(res)).toHaveLength(0);
  });
});

describe('POST /api/salao/pin', () => {
  const device = { [DEVICE_COOKIE]: DEVICE_TOKEN };

  it('PIN certo abre a sessão como aquele funcionário', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await pinPOST(post('/api/salao/pin', { pin: '1111' }, device));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, actor: { name: 'Carlos', role: 'garcom' } });
    const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('PIN errado: 401 e nenhuma sessão', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await pinPOST(post('/api/salao/pin', { pin: '9999' }, device));
    expect(res.status).toBe(401);
    expect(setCookies(res)).toHaveLength(0);
  });

  it('5 erros travam o aparelho por 1 minuto — até o PIN certo é recusado durante a trava', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    for (let i = 0; i < 5; i++) expect((await pinPOST(post('/api/salao/pin', { pin: '9999' }, device))).status).toBe(401);
    const locked = await pinPOST(post('/api/salao/pin', { pin: '1111' }, device));
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toBe('pin_locked');
    expect(setCookies(locked)).toHaveLength(0);
  });

  it('funcionário desativado não entra', async () => {
    const w = world();
    (w.salao_staff[0] as Row).is_active = false;
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    expect((await pinPOST(post('/api/salao/pin', { pin: '1111' }, device))).status).toBe(401);
  });

  it('sem aparelho conectado: 401 device_required', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await pinPOST(post('/api/salao/pin', { pin: '1111' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('device_required');
  });

  it('PIN com formato errado: 400', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    expect((await pinPOST(post('/api/salao/pin', { pin: '12' }, device))).status).toBe(400);
    expect((await pinPOST(post('/api/salao/pin', { pin: 'abcd' }, device))).status).toBe(400);
  });

  it('o PIN de outra conta não abre esta (o HMAC leva o id da conta)', async () => {
    const w = world();
    (w.salao_staff[0] as Row).pin_hmac = pinHmac('outra-conta', '1111');
    mocks.supabaseAdmin.mockReturnValue(fakeDb(w));
    expect((await pinPOST(post('/api/salao/pin', { pin: '1111' }, device))).status).toBe(401);
  });
});

describe('barreira de permissão nas rotas de ação', () => {
  const cookiesFor = (staffId: string, role: 'garcom' | 'caixa' | 'gerente') => ({
    [DEVICE_COOKIE]: DEVICE_TOKEN,
    [SESSION_COOKIE]: signSession({ a: ACCOUNT, d: 'dev-1', s: staffId, r: role }),
  });
  const params = { params: Promise.resolve({ id: 'tab-1' }) };

  it('garçom tenta fechar a comanda: 403 e o fechamento nem é chamado', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await closePOST(post('/api/salao/tabs/tab-1/close', { payments: [] }, cookiesFor('st-g', 'garcom')), params);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it('caixa fecha a comanda', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await closePOST(post('/api/salao/tabs/tab-1/close', { payments: [{ method: 'pix', amount: 10 }] }, cookiesFor('st-c', 'caixa')), params);
    expect(res.status).toBe(200);
    expect(mocks.closeTab).toHaveBeenCalledTimes(1);
  });

  it('o dono libera o fechamento para o garçom na configuração e passa a valer na hora seguinte', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world({ permissions: { garcom: { close_tab: true } } })));
    const res = await closePOST(post('/api/salao/tabs/tab-1/close', { payments: [] }, cookiesFor('st-g', 'garcom')), params);
    expect(res.status).toBe(200);
  });

  it('cookie de sessão forjado como gerente não dá poder de gerente (papel vem do banco)', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await reopenPOST(post('/api/salao/tabs/tab-1/reopen', {}, cookiesFor('st-g', 'gerente')), params);
    expect(res.status).toBe(403);
    expect(mocks.reopenTab).not.toHaveBeenCalled();
  });

  it('assinatura inválida na sessão é tratada como sem PIN (401)', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world()));
    const res = await closePOST(
      post('/api/salao/tabs/tab-1/close', { payments: [] }, { [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: 'eyJhIjoieCJ9.assinatura-falsa' }),
      params,
    );
    expect(res.status).toBe(401);
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it('só o gerente reabre comanda — nem a configuração libera para o caixa', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(world({ permissions: { caixa: { reopen_tab: true } } })));
    const res = await reopenPOST(post('/api/salao/tabs/tab-1/reopen', {}, cookiesFor('st-c', 'caixa')), params);
    expect(res.status).toBe(403);
  });
});
