'use client';

// App do salão (celular do garçom, tablet ou PC do caixa). Sem layout do
// painel: entra por aparelho conectado + PIN, ou direto se o dono/admin
// estiver logado no painel. Navegação por estado, ligada ao botão
// "voltar" do navegador/Android (pushState/popstate).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Loader2, LogOut, ScanLine, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import type { SalaoAction } from '@/lib/salao/permissions';
import { ApiError, AUTH_LOST_EVENT, api } from './api';
import { ConnectScreen, PinScreen } from './access-screens';
import { money } from './format';
import { SalaoUiContext, type SalaoUi, type View } from './salao-context';
import type { Me } from './types';
import { FloorView } from './floor-view';
import { TabView } from './tab-view';
import { AddItemsView } from './add-items-view';
import { CashView } from './cash-view';
import { ScanView } from './scan-view';

type Boot =
  | { state: 'loading' }
  | { state: 'device_required' }
  | { state: 'pin_required'; account_name: string }
  | { state: 'error'; message: string }
  | Me;

const ROLE_LABEL: Record<string, string> = { garcom: 'Garçom', caixa: 'Caixa', gerente: 'Gerente' };

async function loadBoot(): Promise<Boot> {
  try {
    return await api<Boot>('/me');
  } catch (err) {
    return { state: 'error', message: err instanceof ApiError ? err.message : 'Não foi possível abrir o salão.' };
  }
}

export function SalaoApp() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [view, setView] = useState<View>({ name: 'floor' });
  const pendingScan = useRef<string | null>(null);

  const refreshMe = useCallback(async () => {
    setBoot(await loadBoot());
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const mesa = url.searchParams.get('mesa');
    if (mesa) {
      pendingScan.current = mesa;
      url.searchParams.delete('mesa');
      window.history.replaceState({ v: { name: 'floor' } }, '', url.pathname + url.search);
    } else {
      window.history.replaceState({ v: { name: 'floor' } }, '');
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial
    void refreshMe();

    const onPop = (e: PopStateEvent) => setView((e.state?.v as View | undefined) ?? { name: 'floor' });
    const onAuthLost = () => void refreshMe();
    window.addEventListener('popstate', onPop);
    window.addEventListener(AUTH_LOST_EVENT, onAuthLost);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
    };
  }, [refreshMe]);

  const go = useCallback((next: View) => {
    window.history.pushState({ v: next }, '');
    setView(next);
  }, []);

  const back = useCallback(() => {
    if (window.history.state?.v && window.history.length > 1) window.history.back();
    else setView({ name: 'floor' });
  }, []);

  // QR da mesa lido pela câmera nativa do celular: /m/<token> manda para
  // /salao?mesa=<token>; depois do login abrimos a comanda dessa mesa.
  const loggedIn = boot.state === 'ok';
  useEffect(() => {
    const token = pendingScan.current;
    if (!loggedIn || !token) return;
    pendingScan.current = null;
    void (async () => {
      try {
        const res = await api<{ tab_id: string; table_number: number }>('/scan', { body: { token } });
        go({ name: 'tab', id: res.tab_id });
        toast.success(`Mesa ${res.table_number}`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Não foi possível abrir a mesa.');
      }
    })();
  }, [loggedIn, go]);

  const logout = useCallback(async () => {
    await api('/logout', { method: 'POST' }).catch(() => undefined);
    setView({ name: 'floor' });
    await refreshMe();
  }, [refreshMe]);

  const ui = useMemo<SalaoUi | null>(() => {
    if (boot.state !== 'ok') return null;
    const me = boot;
    return {
      me,
      can: (action: SalaoAction) => me.permissions[action] === true,
      fmt: (value: number) => money(value, me.account.currency),
      go,
      back,
      refreshMe,
      logout,
    };
  }, [boot, go, back, refreshMe, logout]);

  if (boot.state === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (boot.state === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-foreground">{boot.message}</p>
        <button type="button" onClick={() => void refreshMe()} className="rounded-lg border border-border px-4 py-2 text-sm">
          Tentar de novo
        </button>
      </main>
    );
  }
  if (boot.state === 'device_required') return <ConnectScreen onConnected={() => void refreshMe()} />;
  if (boot.state === 'pin_required') return <PinScreen accountName={boot.account_name} onDone={() => void refreshMe()} />;
  if (!ui) return null;

  const showNav = view.name === 'floor' || view.name === 'cash' || view.name === 'scan';
  const me = ui.me;

  return (
    <SalaoUiContext.Provider value={ui}>
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col">
        {showNav ? (
          <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{me.account.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {me.actor.name} · {ROLE_LABEL[me.actor.role] ?? me.actor.role}
              </p>
            </div>
            {me.actor.via === 'device' ? (
              <button
                type="button"
                onClick={() => void ui.logout()}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground active:bg-muted"
              >
                <LogOut className="size-3.5" />
                Trocar usuário
              </button>
            ) : (
              <a href="/dashboard" className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground active:bg-muted">
                Voltar ao painel
              </a>
            )}
          </header>
        ) : null}

        <div className="flex-1">
          {view.name === 'floor' ? <FloorView /> : null}
          {view.name === 'tab' ? <TabView tabId={view.id} /> : null}
          {view.name === 'add' ? <AddItemsView tabId={view.id} /> : null}
          {view.name === 'cash' ? <CashView /> : null}
          {view.name === 'scan' ? <ScanView /> : null}
        </div>

        {showNav ? (
          <nav className="sticky bottom-0 z-20 grid grid-cols-3 border-t border-border bg-background/95 backdrop-blur" aria-label="Navegação do salão">
            {(
              [
                { name: 'floor', label: 'Mesas', icon: LayoutGrid },
                { name: 'scan', label: 'Escanear mesa', icon: ScanLine },
                { name: 'cash', label: 'Caixa', icon: Wallet },
              ] as const
            ).map((item) => {
              const active = view.name === item.name;
              return (
                <button
                  key={item.name}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => (active ? undefined : go({ name: item.name }))}
                  className={`flex flex-col items-center gap-1 py-3 text-xs ${active ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
                >
                  <item.icon className="size-5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        ) : null}
      </div>
    </SalaoUiContext.Provider>
  );
}
