'use client';

// Mapa do salão: uma grade de mesas, cada uma é uma comanda.
//   azul    = livre
//   verde   = comanda aberta
//   amarelo = conta pedida (esperando o caixa)

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Minus, Plus, Store, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, api, usePoll } from './api';
import { elapsed } from './format';
import { useSalao } from './salao-context';
import type { Floor, FloorTable, Tab } from './types';

const STATUS_STYLE: Record<FloorTable['status'], { card: string; label: string; dot: string }> = {
  free: { card: 'border-sky-500/50 bg-sky-500/10', label: 'Livre', dot: 'bg-sky-500' },
  open: { card: 'border-emerald-500/60 bg-emerald-500/15', label: 'Aberta', dot: 'bg-emerald-500' },
  bill_requested: { card: 'border-amber-500/70 bg-amber-500/20', label: 'Pediu a conta', dot: 'bg-amber-500' },
};

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function FloorView() {
  const { can, fmt, go, me } = useSalao();
  const { data: floor, error, loading, reload } = usePoll<Floor>('/floor', 4000);
  const now = useNow();
  const [opening, setOpening] = useState<FloorTable | null>(null);
  const [guests, setGuests] = useState(2);
  const [busy, setBusy] = useState(false);

  const areas = useMemo(() => {
    const groups = new Map<string, FloorTable[]>();
    for (const t of floor?.tables ?? []) {
      const key = t.area ?? '';
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    return [...groups.entries()];
  }, [floor?.tables]);

  async function openTab(table: FloorTable | null, peopleCount: number) {
    setBusy(true);
    try {
      const res = await api<{ tab: Tab; existing: boolean }>('/tabs', {
        body: { table_id: table?.id ?? null, guests: peopleCount },
      });
      setOpening(null);
      go({ name: 'tab', id: res.tab.id });
      void reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível abrir.');
    } finally {
      setBusy(false);
    }
  }

  function onTable(table: FloorTable) {
    if (table.tab) {
      go({ name: 'tab', id: table.tab.id });
      return;
    }
    if (!can('open_tab')) {
      toast.error('Seu usuário não pode abrir comanda.');
      return;
    }
    setGuests(2);
    setOpening(table);
  }

  if (loading && !floor) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const cashOpen = !!floor?.cash;

  return (
    <div className="space-y-5 px-4 py-4">
      <section className="grid grid-cols-3 gap-2 text-center" aria-label="Resumo">
        <div className="rounded-xl border border-border bg-card px-2 py-3">
          <p className="text-2xl font-semibold text-foreground">{floor?.totals.open_tabs ?? 0}</p>
          <p className="text-xs text-muted-foreground">comandas abertas</p>
        </div>
        <div className="rounded-xl border border-border bg-card px-2 py-3">
          <p className="text-lg font-semibold text-foreground">{fmt(floor?.totals.open_total ?? 0)}</p>
          <p className="text-xs text-muted-foreground">em aberto</p>
        </div>
        <button
          type="button"
          onClick={() => go({ name: 'cash' })}
          className={`rounded-xl border px-2 py-3 ${cashOpen ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-amber-500/60 bg-amber-500/15'}`}
        >
          <p className="text-lg font-semibold text-foreground">{cashOpen ? 'Aberto' : 'Fechado'}</p>
          <p className="text-xs text-muted-foreground">caixa</p>
        </button>
      </section>

      {error && !floor ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
          {error.message}
        </p>
      ) : null}
      {error && floor ? <p className="text-center text-xs text-muted-foreground">Sem conexão — mostrando o último estado.</p> : null}

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legenda">
        {(['free', 'open', 'bill_requested'] as const).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-full ${STATUS_STYLE[s].dot}`} />
            {STATUS_STYLE[s].label}
          </li>
        ))}
      </ul>

      {floor && floor.tables.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nenhuma mesa cadastrada ainda.{' '}
          {me.actor.via === 'panel' ? 'Crie as mesas em Configurações > Salão.' : 'Peça ao responsável para criar as mesas.'}
        </div>
      ) : null}

      {areas.map(([area, tables]) => (
        <section key={area || 'sem-area'} className="space-y-2">
          {area ? <h2 className="text-sm font-semibold text-foreground">{area}</h2> : null}
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {tables.map((table) => {
              const style = STATUS_STYLE[table.status];
              return (
                <li key={table.id}>
                  <button
                    type="button"
                    onClick={() => onTable(table)}
                    className={`flex aspect-square w-full flex-col items-center justify-between rounded-2xl border-2 p-2 text-foreground transition active:scale-95 ${style.card}`}
                  >
                    <span className="text-xs text-foreground/70">{table.name ?? 'Mesa'}</span>
                    <span className="text-3xl leading-none font-bold">{table.number}</span>
                    <span className="text-center text-[11px] leading-tight text-foreground/80">
                      {table.tab ? (
                        <>
                          <span className="block font-semibold">{fmt(table.tab.total)}</span>
                          <span className="flex items-center justify-center gap-1">
                            <Users className="size-3" />
                            {table.tab.guests} · {elapsed(table.tab.opened_at, now)}
                          </span>
                        </>
                      ) : (
                        style.label
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Balcão</h2>
          {can('open_tab') ? (
            <Button variant="outline" disabled={busy} onClick={() => void openTab(null, 1)}>
              <Store className="size-4" />
              Nova venda no balcão
            </Button>
          ) : null}
        </div>
        {(floor?.counter_tabs ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma venda de balcão em aberto.</p>
        ) : (
          <ul className="space-y-2">
            {(floor?.counter_tabs ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => go({ name: 'tab', id: c.id })}
                  className="flex w-full items-center justify-between rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-left active:bg-emerald-500/20"
                >
                  <span className="font-medium text-foreground">{c.label}</span>
                  <span className="text-sm text-foreground/80">
                    {fmt(c.total)} · {elapsed(c.opened_at, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={!!opening} onOpenChange={(open) => (!open ? setOpening(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Abrir mesa {opening?.number}</DialogTitle>
            <DialogDescription>Quantas pessoas estão na mesa?</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-6 py-2">
            <Button variant="outline" size="icon-lg" aria-label="Menos uma pessoa" onClick={() => setGuests((g) => Math.max(1, g - 1))}>
              <Minus className="size-4" />
            </Button>
            <span className="w-12 text-center text-4xl font-semibold text-foreground">{guests}</span>
            <Button variant="outline" size="icon-lg" aria-label="Mais uma pessoa" onClick={() => setGuests((g) => Math.min(99, g + 1))}>
              <Plus className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button className="h-11 w-full text-base" disabled={busy} onClick={() => opening && void openTab(opening, guests)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Abrir comanda
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
