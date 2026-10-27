'use client';

// A comanda de uma mesa (ou de uma venda de balcão): o que já foi pedido
// por rodada, o total, e as ações que o usuário tem permissão de fazer.

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Loader2, Percent, Plus, Printer, ReceiptText, RotateCcw, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, api, usePoll } from './api';
import { addonLabel, timeOfDay } from './format';
import { useSalao } from './salao-context';
import { CancelItemDialog, DiscountDialog, GuestsDialog, PaymentDialog, TransferDialog } from './tab-dialogs';
import type { TabDetail, TabItem } from './types';
import { METHOD_LABEL } from './types';

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  open: { label: 'Aberta', className: 'border-emerald-500/60 bg-emerald-500/15' },
  bill_requested: { label: 'Pediu a conta', className: 'border-amber-500/70 bg-amber-500/20' },
  closed: { label: 'Fechada', className: 'border-sky-500/50 bg-sky-500/10' },
  cancelled: { label: 'Cancelada', className: 'border-border bg-muted' },
};

export function TabView({ tabId }: { tabId: string }) {
  const { can, fmt, go, back } = useSalao();
  const { data, error, loading, reload } = usePoll<TabDetail>(`/tabs/${tabId}`, 4000);
  const [cancelling, setCancelling] = useState<TabItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const byRound = useMemo(() => {
    if (!data) return [];
    return data.rounds.map((round) => ({ round, items: data.items.filter((i) => i.round_id === round.id) }));
  }, [data]);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4 p-6 text-center">
        <p className="text-foreground">{error?.message ?? 'Comanda não encontrada.'}</p>
        <Button variant="outline" onClick={back}>
          Voltar
        </Button>
      </div>
    );
  }

  const { tab, payments } = data;
  const isOpen = tab.status === 'open' || tab.status === 'bill_requested';
  const activeItems = data.items.filter((i) => i.status === 'active');
  const badge = STATUS_BADGE[tab.status] ?? STATUS_BADGE.open;
  const perPerson = tab.guests > 1 && tab.total > 0 ? Math.round((tab.total / tab.guests) * 100) / 100 : null;

  async function requestBill() {
    setBusy(true);
    try {
      const res = await api<{ printed: boolean }>(`/tabs/${tab.id}/bill`, { method: 'POST' });
      toast.success(res.printed ? 'Pré-conta enviada para a impressora do caixa.' : 'Conta pedida. A impressão está desligada nesta conta.');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível pedir a conta.');
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true);
    try {
      await api(`/tabs/${tab.id}/reopen`, { method: 'POST' });
      toast.success('Comanda reaberta.');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível reabrir.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/95 px-3 py-3 backdrop-blur">
        <button type="button" onClick={back} aria-label="Voltar" className="rounded-lg p-2 text-foreground active:bg-muted">
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-foreground">{tab.label}</h1>
          <p className="truncate text-xs text-muted-foreground">
            aberta às {timeOfDay(tab.opened_at)} por {tab.opened_by_name}
            {tab.customer_name ? ` · ${tab.customer_name}` : ''}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium text-foreground ${badge.className}`}>{badge.label}</span>
      </header>

      <div className="flex-1 space-y-4 px-4 py-4 pb-40">
        {error ? <p className="text-center text-xs text-muted-foreground">Sem conexão — mostrando o último estado.</p> : null}

        {tab.status === 'cancelled' ? (
          <p className="rounded-xl border border-border bg-muted p-4 text-sm text-foreground">
            Esta comanda foi juntada a outra mesa. Os itens estão na comanda de destino.
          </p>
        ) : null}

        {byRound.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Nenhum item ainda. Toque em <strong className="text-foreground">Adicionar itens</strong> para começar.
          </div>
        ) : (
          byRound.map(({ round, items }) => (
            <section key={round.id} className="space-y-2">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Rodada {round.number} · {timeOfDay(round.created_at)} · {round.sent_by_name}
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {items.map((item) => (
                  <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
                    <span className={`w-8 shrink-0 text-center text-base font-semibold ${item.status === 'cancelled' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                      {item.quantity}×
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium ${item.status === 'cancelled' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {item.product_name}
                      </p>
                      {addonLabel(item.addons_snapshot).map((line) => (
                        <p key={line} className="text-xs text-muted-foreground">
                          {line}
                        </p>
                      ))}
                      {item.notes ? <p className="text-xs text-muted-foreground italic">“{item.notes}”</p> : null}
                      {item.status === 'cancelled' ? (
                        <p className="text-xs text-destructive">
                          Cancelado{item.cancelled_by_name ? ` por ${item.cancelled_by_name}` : ''}
                          {item.cancelled_reason ? `: ${item.cancelled_reason}` : ''}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`text-sm ${item.status === 'cancelled' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {fmt(item.line_total)}
                      </span>
                      {isOpen && item.status === 'active' && can('cancel_item') ? (
                        <button
                          type="button"
                          onClick={() => setCancelling(item)}
                          aria-label={`Cancelar ${item.product_name}`}
                          className="rounded-md p-1 text-muted-foreground active:bg-muted"
                        >
                          <X className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 text-sm" aria-label="Totais">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span>{fmt(tab.subtotal)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Taxa de serviço{tab.service_fee_enabled ? ` (${tab.service_fee_percent}%)` : ' (não cobrada)'}</span>
            <span>{fmt(tab.service_fee_amount)}</span>
          </div>
          {tab.discount_amount > 0 ? (
            <div className="flex justify-between text-muted-foreground">
              <span>Desconto</span>
              <span>− {fmt(tab.discount_amount)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold text-foreground">
            <span>Total</span>
            <span>{fmt(tab.total)}</span>
          </div>
          {perPerson ? (
            <p className="text-right text-xs text-muted-foreground">
              {fmt(perPerson)} por pessoa ({tab.guests})
            </p>
          ) : null}
        </section>

        {payments.length > 0 ? (
          <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 text-sm">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Pagamentos</h2>
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between text-foreground">
                <span>
                  {METHOD_LABEL[p.method]}
                  {p.change_amount > 0 ? <span className="text-muted-foreground"> · troco {fmt(p.change_amount)}</span> : null}
                </span>
                <span>{fmt(p.amount)}</span>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              Fechada às {tab.closed_at ? timeOfDay(tab.closed_at) : ''} por {tab.closed_by_name}
            </p>
          </section>
        ) : null}
      </div>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 pt-3 pb-4 backdrop-blur">
        <div className="mx-auto max-w-3xl space-y-2">
          {isOpen ? (
            <>
              <div className="grid grid-cols-4 gap-2">
                {can('transfer_tab') ? (
                  <Button variant="outline" className="h-12 flex-col gap-0.5 px-1 text-[11px]" onClick={() => setTransferOpen(true)}>
                    <ArrowRightLeft className="size-4" />
                    Mudar mesa
                  </Button>
                ) : (
                  <span />
                )}
                <Button variant="outline" className="h-12 flex-col gap-0.5 px-1 text-[11px]" onClick={() => setGuestsOpen(true)}>
                  <Users className="size-4" />
                  {tab.guests} pessoa{tab.guests === 1 ? '' : 's'}
                </Button>
                {can('apply_discount') ? (
                  <Button variant="outline" className="h-12 flex-col gap-0.5 px-1 text-[11px]" onClick={() => setDiscountOpen(true)}>
                    <Percent className="size-4" />
                    Desconto
                  </Button>
                ) : (
                  <span />
                )}
                {can('request_bill') ? (
                  <Button variant="outline" className="h-12 flex-col gap-0.5 px-1 text-[11px]" disabled={busy || activeItems.length === 0} onClick={() => void requestBill()}>
                    <Printer className="size-4" />
                    {tab.status === 'bill_requested' ? 'Reimprimir conta' : 'Pedir a conta'}
                  </Button>
                ) : (
                  <span />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {can('add_items') ? (
                  <Button className="h-12 text-base" onClick={() => go({ name: 'add', id: tab.id })}>
                    <Plus className="size-4" />
                    Adicionar itens
                  </Button>
                ) : null}
                {can('close_tab') ? (
                  <Button variant="secondary" className="h-12 text-base" onClick={() => setPayOpen(true)}>
                    <ReceiptText className="size-4" />
                    Fechar conta
                  </Button>
                ) : (
                  <p className="col-span-1 self-center text-center text-xs text-muted-foreground">O caixa fecha a conta.</p>
                )}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-12" onClick={() => go({ name: 'floor' })}>
                Ver mesas
              </Button>
              {tab.status === 'closed' && can('reopen_tab') ? (
                <Button variant="outline" className="h-12" disabled={busy} onClick={() => void reopen()}>
                  <RotateCcw className="size-4" />
                  Reabrir
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </footer>

      <CancelItemDialog
        tabId={tab.id}
        item={cancelling}
        onClose={() => setCancelling(null)}
        onDone={() => {
          setCancelling(null);
          void reload();
        }}
      />
      <TransferDialog
        open={transferOpen}
        tab={tab}
        onClose={() => setTransferOpen(false)}
        onDone={(id) => {
          setTransferOpen(false);
          if (id !== tab.id) go({ name: 'tab', id });
          else void reload();
        }}
      />
      <GuestsDialog
        open={guestsOpen}
        tab={tab}
        onClose={() => setGuestsOpen(false)}
        onDone={() => {
          setGuestsOpen(false);
          void reload();
        }}
      />
      <DiscountDialog
        open={discountOpen}
        tab={tab}
        onClose={() => setDiscountOpen(false)}
        onDone={() => {
          setDiscountOpen(false);
          void reload();
        }}
      />
      <PaymentDialog
        open={payOpen}
        tab={tab}
        onClose={() => setPayOpen(false)}
        onDone={(change) => {
          setPayOpen(false);
          toast.success(change > 0 ? `Comanda fechada. Troco: ${fmt(change)}` : 'Comanda fechada.');
          go({ name: 'floor' });
        }}
      />
    </div>
  );
}
