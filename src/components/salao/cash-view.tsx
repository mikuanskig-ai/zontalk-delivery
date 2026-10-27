'use client';

// Caixa do dia: abrir com o fundo de troco, sangria/suprimento, ver o
// parcial (salão + delivery) e fechar com o dinheiro contado.

import { useState } from 'react';
import { Banknote, Loader2, Lock, Printer, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { CashReportTicket, DeliveryMethodKey, PaymentMethodKey } from '@/lib/salao/tickets';
import { ApiError, api, usePoll } from './api';
import { parseMoneyInput, timeOfDay } from './format';
import { useSalao } from './salao-context';
import type { CashSession } from './types';
import { METHOD_LABEL } from './types';

interface CashResponse {
  cash: CashSession | null;
  report: CashReportTicket | null;
  history: {
    id: string;
    opened_at: string;
    closed_at: string | null;
    opened_by_name: string;
    closed_by_name: string | null;
    counted_cash: number | null;
    expected_cash: number | null;
    difference: number | null;
  }[];
}

interface CloseResult {
  session_id: string;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  printed: boolean;
  open_tabs_left: number;
}

const DELIVERY_LABEL: Record<DeliveryMethodKey, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  card: 'Cartão',
  other: 'Outros',
  unknown: 'Sem forma informada',
};

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function CashView() {
  const { can, fmt } = useSalao();
  const { data, error, loading, reload } = usePoll<CashResponse>('/cash', 6000);
  const [floatText, setFloatText] = useState('');
  const [busy, setBusy] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);

  const [kind, setKind] = useState<'withdrawal' | 'supply'>('withdrawal');
  const [movAmount, setMovAmount] = useState('');
  const [movReason, setMovReason] = useState('');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');

  if (loading && !data) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const cash = data?.cash ?? null;
  const report = data?.report ?? null;

  async function openCash() {
    const value = floatText.trim() ? parseMoneyInput(floatText) : 0;
    if (Number.isNaN(value) || value < 0) {
      toast.error('Valor do fundo de troco inválido.');
      return;
    }
    setBusy(true);
    try {
      await api('/cash/open', { body: { opening_float: value } });
      toast.success('Caixa aberto.');
      setFloatText('');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível abrir o caixa.');
    } finally {
      setBusy(false);
    }
  }

  async function saveMovement() {
    const amount = parseMoneyInput(movAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error('Informe um valor maior que zero.');
      return;
    }
    setBusy(true);
    try {
      await api('/cash/movements', { body: { kind, amount, reason: movReason } });
      toast.success(kind === 'withdrawal' ? 'Sangria registrada.' : 'Suprimento registrado.');
      setMovementOpen(false);
      setMovAmount('');
      setMovReason('');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível registrar.');
    } finally {
      setBusy(false);
    }
  }

  async function closeCash() {
    const value = parseMoneyInput(counted);
    if (Number.isNaN(value) || value < 0) {
      toast.error('Informe quanto tem em dinheiro no caixa.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<CloseResult>('/cash/close', { body: { counted_cash: value, notes } });
      setCloseOpen(false);
      setCounted('');
      setNotes('');
      setResult(res);
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível fechar o caixa.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 px-4 py-4">
      <h1 className="text-lg font-semibold text-foreground">Caixa</h1>
      {error && !data ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {!cash ? (
        <section className="space-y-3 rounded-xl border border-amber-500/60 bg-amber-500/10 p-4">
          <div className="flex items-center gap-2 text-foreground">
            <Lock className="size-4" />
            <p className="font-medium">O caixa está fechado</p>
          </div>
          {can('open_cash') ? (
            <>
              <p className="text-sm text-muted-foreground">Informe o dinheiro de troco que está na gaveta para abrir o dia.</p>
              <Input inputMode="decimal" value={floatText} onChange={(e) => setFloatText(e.target.value)} placeholder="Fundo de troco (ex.: 150,00)" className="h-11" />
              <Button className="h-11 w-full text-base" disabled={busy} onClick={() => void openCash()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Unlock className="size-4" />}
                Abrir caixa
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Peça ao caixa ou ao gerente para abrir.</p>
          )}
        </section>
      ) : (
        <>
          <section className="space-y-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Unlock className="size-4" />
              Caixa aberto às {timeOfDay(cash.opened_at)} por {cash.opened_by_name}
            </div>
            <Row label="Fundo de troco" value={fmt(cash.opening_float)} />
          </section>

          {report ? (
            <>
              <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 text-sm">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Vendas no salão e balcão</h2>
                <Row label={`${report.salao_tabs_count} comanda${report.salao_tabs_count === 1 ? '' : 's'} fechada${report.salao_tabs_count === 1 ? '' : 's'}`} value={fmt(report.salao_total)} strong />
                {(Object.keys(report.salao_by_method) as PaymentMethodKey[])
                  .filter((m) => report.salao_by_method[m] > 0)
                  .map((m) => (
                    <Row key={m} label={METHOD_LABEL[m]} value={fmt(report.salao_by_method[m])} />
                  ))}
                {report.supply_total > 0 ? <Row label="Suprimentos" value={fmt(report.supply_total)} /> : null}
                {report.withdrawal_total > 0 ? <Row label="Sangrias" value={`− ${fmt(report.withdrawal_total)}`} /> : null}
              </section>

              <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 text-sm">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Delivery no período (a conferir)</h2>
                <Row label={`${report.delivery_orders_count} pedido${report.delivery_orders_count === 1 ? '' : 's'}`} value={fmt(report.delivery_total)} strong />
                {(Object.keys(report.delivery_by_method) as DeliveryMethodKey[])
                  .filter((m) => report.delivery_by_method[m].count > 0)
                  .map((m) => (
                    <Row key={m} label={`${DELIVERY_LABEL[m]} (${report.delivery_by_method[m].count})`} value={fmt(report.delivery_by_method[m].total)} />
                  ))}
                <p className="pt-1 text-xs text-muted-foreground">
                  A forma de pagamento do delivery é escrita à mão e não entra na conta do dinheiro do caixa.
                </p>
              </section>
            </>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            {can('cash_movement') ? (
              <Button variant="outline" className="h-12" onClick={() => setMovementOpen(true)}>
                <Banknote className="size-4" />
                Sangria / suprimento
              </Button>
            ) : (
              <span />
            )}
            {can('close_cash') ? (
              <Button variant="secondary" className="h-12" onClick={() => setCloseOpen(true)}>
                <Lock className="size-4" />
                Fechar caixa
              </Button>
            ) : null}
          </div>
        </>
      )}

      {(data?.history ?? []).length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Caixas anteriores</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
            {data!.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-foreground">{h.closed_at ? new Date(h.closed_at).toLocaleDateString('pt-BR') : ''}</span>
                  <span className="block truncate text-xs text-muted-foreground">{h.closed_by_name ?? h.opened_by_name}</span>
                </span>
                <span className="text-right">
                  <span className={`block font-medium ${h.difference && Math.abs(h.difference) >= 0.01 ? 'text-destructive' : 'text-foreground'}`}>
                    {h.difference == null ? '' : h.difference === 0 ? 'Bateu' : `${h.difference > 0 ? 'Sobra' : 'Falta'} ${fmt(Math.abs(h.difference))}`}
                  </span>
                  <a href={`/salao/relatorio/${h.id}`} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                    Relatório
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog open={movementOpen} onOpenChange={setMovementOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sangria ou suprimento</DialogTitle>
            <DialogDescription>Sangria tira dinheiro da gaveta; suprimento coloca troco.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {(['withdrawal', 'supply'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg border px-3 py-3 text-sm ${kind === k ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground'}`}
              >
                {k === 'withdrawal' ? 'Sangria (tirar)' : 'Suprimento (colocar)'}
              </button>
            ))}
          </div>
          <Input inputMode="decimal" value={movAmount} onChange={(e) => setMovAmount(e.target.value)} placeholder="Valor" className="h-11" />
          <Input value={movReason} maxLength={200} onChange={(e) => setMovReason(e.target.value)} placeholder="Motivo (opcional)" className="h-11" />
          <DialogFooter>
            <Button className="h-11 w-full text-base" disabled={busy} onClick={() => void saveMovement()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fechar o caixa</DialogTitle>
            <DialogDescription>Conte o dinheiro da gaveta e digite o total. O sistema compara com o esperado depois.</DialogDescription>
          </DialogHeader>
          <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="Dinheiro contado na gaveta" className="h-11" />
          <Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Observação (opcional)" className="h-11" />
          <DialogFooter>
            <Button className="h-12 w-full text-base" disabled={busy} onClick={() => void closeCash()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Fechar caixa e imprimir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!result} onOpenChange={(open) => (!open ? setResult(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Caixa fechado</DialogTitle>
            <DialogDescription>
              {result?.printed ? 'O relatório foi enviado para a impressora do caixa.' : 'A impressão está desligada nesta conta. Abra o relatório pelo navegador.'}
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="space-y-1.5 text-sm">
              <Row label="Esperado em dinheiro" value={fmt(result.expected_cash)} />
              <Row label="Contado" value={fmt(result.counted_cash)} />
              <Row
                label={result.difference === 0 ? 'Diferença' : result.difference > 0 ? 'Sobrou' : 'Faltou'}
                value={result.difference === 0 ? 'Bateu certinho' : fmt(Math.abs(result.difference))}
                strong
              />
              {result.open_tabs_left > 0 ? (
                <p className="pt-2 text-xs text-destructive">
                  Atenção: ainda há {result.open_tabs_left} comanda{result.open_tabs_left === 1 ? '' : 's'} aberta{result.open_tabs_left === 1 ? '' : 's'}. O pagamento delas entra no próximo caixa.
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <a
              href={result ? `/salao/relatorio/${result.session_id}` : '#'}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium text-foreground"
            >
              <Printer className="size-4" />
              Ver relatório
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
