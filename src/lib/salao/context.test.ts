import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  getCurrentAccount: vi.fn(),
}));

vi.mock('@/lib/payments/admin-client', () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: mocks.getCurrentAccount }));

import { DEVICE_COOKIE, SESSION_COOKIE, sha256Hex, signSession } from './crypto';
import { SalaoError, invalidateSalaoSnapshot, requireSalao, requireSalaoAdmin, resolveActor, sqlErrorToSalaoError } from './context';

type Row = Record<string, unknown>;

/** Banco de mentira: cada tabela é uma lista; `eq` filtra, `update` altera no lugar. */
function fakeDb(tables: Record<string, Row[]>) {
  function chain(name: string) {
    let rows = tables[name] ?? [];
    const c = {
      select: () => c,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return c;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      update: (patch: Row) => {
        const target = rows;
        const u = {
          eq: (col: string, val: unknown) => {
            for (const r of target) if (r[col] === val) Object.assign(r, patch);
            return u;
          },
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        };
        return u;
      },
    };
    return c;
  }
  return { from: (name: string) => chain(name) };
}

const ACCOUNT_ID = 'acc-1';
const DEVICE_TOKEN = 'token-do-aparelho';

function seed(overrides: { staffRole?: string; staffActive?: boolean; revoked?: boolean; modules?: string[]; permissions?: unknown } = {}) {
  return {
    salao_devices: [
      { id: 'dev-1', account_id: ACCOUNT_ID, token_hash: sha256Hex(DEVICE_TOKEN), revoked_at: overrides.revoked ? '2026-01-01' : null, last_seen_at: new Date().toISOString() },
    ],
    salao_staff: [{ id: 'staff-1', account_id: ACCOUNT_ID, name: 'Carlos', role: overrides.staffRole ?? 'garcom', is_active: overrides.staffActive ?? true }],
    accounts: [{ id: ACCOUNT_ID, name: 'Concórdia', default_currency: 'BRL', slug: 'concordia', enabled_modules: overrides.modules ?? ['delivery', 'salao'], status: 'active' }],
    salao_settings: [
      { account_id: ACCOUNT_ID, service_fee_percent: 10, service_fee_default_on: true, require_open_cash: true, permissions: overrides.permissions ?? {} },
    ],
  };
}

function req(cookies: Record<string, string> = {}): Request {
  const header = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  return new Request('http://localhost/api/salao/floor', { headers: header ? { cookie: header } : {} });
}

const session = (over: Partial<{ a: string; d: string; s: string; r: 'garcom' | 'caixa' | 'gerente' }> = {}) =>
  signSession({ a: ACCOUNT_ID, d: 'dev-1', s: 'staff-1', r: 'garcom', ...over });

beforeEach(() => {
  process.env.SALAO_SECRET = 'segredo-de-teste';
  mocks.supabaseAdmin.mockReset();
  mocks.getCurrentAccount.mockReset();
  mocks.getCurrentAccount.mockRejectedValue(new Error('sem sessão de painel'));
  invalidateSalaoSnapshot(ACCOUNT_ID);
});

describe('resolveActor', () => {
  it('sem cookie nenhum: precisa conectar o aparelho', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    expect(await resolveActor(req())).toEqual({ state: 'device_required' });
  });

  it('aparelho conectado sem PIN: pede o PIN', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    expect(await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN }))).toMatchObject({ state: 'pin_required', deviceId: 'dev-1', accountId: ACCOUNT_ID });
  });

  it('aparelho + sessão válida: entra como o funcionário', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    const res = await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session() }));
    expect(res).toMatchObject({ state: 'ok', actor: { name: 'Carlos', role: 'garcom', staffId: 'staff-1', via: 'device' } });
  });

  it('o papel vale pelo banco, não pelo cookie: garçom rebaixado de gerente não mantém o poder', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ staffRole: 'garcom' })));
    const res = await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session({ r: 'gerente' }) }));
    expect(res).toMatchObject({ state: 'ok', actor: { role: 'garcom' } });
  });

  it('funcionário desativado é barrado mesmo com sessão válida', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ staffActive: false })));
    const res = await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session() }));
    expect(res.state).toBe('pin_required');
  });

  it('aparelho revogado volta a exigir a conexão', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ revoked: true })));
    const res = await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session() }));
    expect(res).toEqual({ state: 'device_required' });
  });

  it('sessão emitida para outro aparelho não vale neste', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    const res = await resolveActor(req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session({ d: 'outro-aparelho' }) }));
    expect(res.state).toBe('pin_required');
  });

  it('token de aparelho inventado não conecta', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    expect(await resolveActor(req({ [DEVICE_COOKIE]: 'inventado' }))).toEqual({ state: 'device_required' });
  });

  it('admin logado no painel entra como gerente, sem PIN', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    mocks.getCurrentAccount.mockResolvedValue({
      accountId: ACCOUNT_ID,
      userId: 'user-1',
      role: 'admin',
      supabase: fakeDb({ profiles: [{ user_id: 'user-1', full_name: 'Guilherme' }] }),
    });
    const res = await resolveActor(req());
    expect(res).toMatchObject({ state: 'ok', actor: { role: 'gerente', name: 'Guilherme', via: 'panel', staffId: null } });
  });

  it('atendente (agent) do painel NÃO vira gerente do salão', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    mocks.getCurrentAccount.mockResolvedValue({ accountId: ACCOUNT_ID, userId: 'u', role: 'agent', supabase: fakeDb({}) });
    expect(await resolveActor(req())).toEqual({ state: 'device_required' });
  });
});

describe('requireSalao', () => {
  const asWaiter = () => req({ [DEVICE_COOKIE]: DEVICE_TOKEN, [SESSION_COOKIE]: session() });

  it('garçom não consegue fechar comanda por padrão (403 forbidden)', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    await expect(requireSalao(asWaiter(), { action: 'close_tab' })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('garçom lança itens normalmente', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    const ctx = await requireSalao(asWaiter(), { action: 'add_items' });
    expect(ctx.accountId).toBe(ACCOUNT_ID);
    expect(ctx.actor.role).toBe('garcom');
  });

  it('o dono pode liberar o fechamento para o garçom', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ permissions: { garcom: { close_tab: true } } })));
    await expect(requireSalao(asWaiter(), { action: 'close_tab' })).resolves.toMatchObject({ actor: { role: 'garcom' } });
  });

  it('caixa fecha comanda; garçom dono-liberado cancelar item continua bloqueado se não foi liberado', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ staffRole: 'caixa' })));
    await expect(requireSalao(asWaiter(), { action: 'close_tab' })).resolves.toBeTruthy();
    invalidateSalaoSnapshot(ACCOUNT_ID);
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ staffRole: 'caixa', permissions: { caixa: { cancel_item: false } } })));
    await expect(requireSalao(asWaiter(), { action: 'cancel_item' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('módulo desligado na conta: 403 module_disabled, mesmo com aparelho e PIN válidos', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ modules: ['delivery'] })));
    await expect(requireSalao(asWaiter())).rejects.toMatchObject({ status: 403, code: 'module_disabled' });
  });

  it('sem PIN: 401 pin_required', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    await expect(requireSalao(req({ [DEVICE_COOKIE]: DEVICE_TOKEN }))).rejects.toMatchObject({ status: 401, code: 'pin_required' });
  });

  it('sem aparelho: 401 device_required', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    await expect(requireSalao(req())).rejects.toMatchObject({ status: 401, code: 'device_required' });
  });
});

describe('requireSalaoAdmin', () => {
  it('só admin+ do painel', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    mocks.getCurrentAccount.mockResolvedValue({ accountId: ACCOUNT_ID, userId: 'u', role: 'agent', supabase: fakeDb({}) });
    await expect(requireSalaoAdmin()).rejects.toMatchObject({ status: 403 });

    mocks.getCurrentAccount.mockResolvedValue({ accountId: ACCOUNT_ID, userId: 'u', role: 'owner', supabase: fakeDb({}) });
    await expect(requireSalaoAdmin()).resolves.toMatchObject({ accountId: ACCOUNT_ID });
  });

  it('um funcionário de aparelho (sem sessão de painel) não configura nada', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed()));
    await expect(requireSalaoAdmin()).rejects.toMatchObject({ status: 401 });
  });

  it('exige o módulo ligado', async () => {
    mocks.supabaseAdmin.mockReturnValue(fakeDb(seed({ modules: ['delivery'] })));
    mocks.getCurrentAccount.mockResolvedValue({ accountId: ACCOUNT_ID, userId: 'u', role: 'admin', supabase: fakeDb({}) });
    await expect(requireSalaoAdmin()).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('sqlErrorToSalaoError', () => {
  it('traduz os códigos das funções SQL, mesmo com texto em volta', () => {
    expect(sqlErrorToSalaoError('tab_not_open')).toMatchObject({ status: 409, code: 'tab_not_open' });
    expect(sqlErrorToSalaoError('P0001: payments_mismatch\nCONTEXT: PL/pgSQL')).toMatchObject({ status: 409, code: 'payments_mismatch' });
    expect(sqlErrorToSalaoError('cash_session_closed')).toMatchObject({ code: 'cash_session_closed' });
    expect(sqlErrorToSalaoError('table_busy')).toMatchObject({ code: 'table_busy' });
  });

  it('erro desconhecido vira 500 genérico, sem vazar a mensagem do banco', () => {
    const err = sqlErrorToSalaoError('relation "x" does not exist');
    expect(err).toBeInstanceOf(SalaoError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain('relation');
  });
});
