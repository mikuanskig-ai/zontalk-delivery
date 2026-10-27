'use client';

// Janelas da comanda: cancelar item, transferir mesa, pessoas, desconto
// e o fechamento com pagamentos (várias formas, dinheiro com troco).

import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, Loader2, Minus, Plus, QrCode, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, api } from './api';
import { parseMoneyInput } from './format';
import { useSalao } from './salao-context';
import { METHOD_LABEL, type Floor, type PaymentMethod, type Tab, type TabItem } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ------------------------------------------------------------
// Cancelar item
// ------------------------------------------------------------

const QUICK_REASONS = ['Lançado errado', 'Cliente desistiu', 'Demorou demais', 'Acabou no estoque'];

export function CancelItemDialog({
  tabId,
  item,
  onClose,
  onDone,
}: {
  tabId: string;
  item: TabItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
     
    setReason('');
  }, [item?.id]);

  async function confirm() {
    if (!item || !reason.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ printed: boolean }>(`/tabs/${tabId}/items/${item.id}/cancel`, { body: { reason } });
      toast.success(res.printed ? 'Item cancelado. A cozinha foi avisada.' : 'Item cancelado.');
      onDone();
    } catch (err) {
      toast.error(errMessage(err, 'Não foi possível cancelar.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancelar item</DialogTitle>
          <DialogDescription>
            {item ? `${item.quantity}× ${item.product_name}` : ''} — a cozinha recebe um aviso impresso.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {QUICK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={`rounded-full border px-3 py-1.5 text-xs ${reason === r ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}
            >
              {r}
            </button>
          ))}
        </div>
        <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obrigatório)" className="h-11" />
        <DialogFooter>
          <Button variant="destructive" className="h-11 w-full text-base" disabled={busy || !reason.trim()} onClick={() => void confirm()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Cancelar item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Transferir / juntar mesa
// ------------------------------------------------------------

export function TransferDialog({
  open,
  tab,
  onClose,
  onDone,
}: {
  open: boolean;
  tab: Tab;
  onClose: () => void;
  onDone: (tabId: string) => void;
}) {
  const [floor, setFloor] = useState<Floor | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<Floor>('/floor')
      .then((f) => !cancelled && setFloor(f))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function transfer(tableId: string) {
    setBusy(true);
    try {
      const res = await api<{ tab_id: string; merged: boolean }>(`/tabs/${tab.id}/transfer`, { body: { to_table_id: tableId } });
      toast.success(res.merged ? 'Comandas juntadas.' : 'Comanda transferida.');
      onDone(res.tab_id);
    } catch (err) {
      toast.error(errMessage(err, 'Não foi possível transferir.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transferir {tab.label}</DialogTitle>
          <DialogDescription>Escolha a mesa de destino. Mesa já ocupada (verde) junta as duas comandas.</DialogDescription>
        </DialogHeader>
        {!floor ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <ul className="grid grid-cols-4 gap-2">
            {floor.tables
              .filter((t) => t.id !== tab.table_id)
              .map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void transfer(t.id)}
                    className={`flex h-14 w-full flex-col items-center justify-center rounded-xl border-2 text-foreground active:scale-95 disabled:opacity-50 ${t.tab ? 'border-emerald-500/60 bg-emerald-500/15' : 'border-sky-500/50 bg-sky-500/10'}`}
                  >
                    <span className="text-lg font-bold leading-none">{t.number}</span>
                    <span className="text-[10px] text-foreground/70">{t.tab ? 'juntar' : 'livre'}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Pessoas na mesa
// ------------------------------------------------------------

export function GuestsDialog({ open, tab, onClose, onDone }: { open: boolean; tab: Tab; onClose: () => void; onDone: () => void }) {
  const [guests, setGuests] = useState(tab.guests);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
     
    if (open) setGuests(tab.guests);
  }, [open, tab.guests]);

  async function save() {
    setBusy(true);
    try {
      await api(`/tabs/${tab.id}`, { method: 'PATCH', body: { guests } });
      onDone();
    } catch (err) {
      toast.error(errMessage(err, 'Não foi possível salvar.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pessoas na mesa</DialogTitle>
          <DialogDescription>Usado para dividir a conta.</DialogDescription>
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
          <Button className="h-11 w-full text-base" disabled={busy} onClick={() => void save()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Desconto e taxa de serviço
// ------------------------------------------------------------

export function DiscountDialog({ open, tab, onClose, onDone }: { open: boolean; tab: Tab; onClose: () => void; onDone: () => void }) {
  const [discount, setDiscount] = useState('');
  const [fee, setFee] = useState(tab.service_fee_enabled);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
     
    setDiscount(tab.discount_amount > 0 ? String(tab.discount_amount).replace('.', ',') : '');
    setFee(tab.service_fee_enabled);
  }, [open, tab.discount_amount, tab.service_fee_enabled]);

  async function save() {
    const value = discount.trim() ? parseMoneyInput(discount) : 0;
    if (Number.isNaN(value) || value < 0) {
      toast.error('Valor de desconto inválido.');
      return;
    }
    setBusy(true);
    try {
      await api(`/tabs/${tab.id}`, { method: 'PATCH', body: { discount_amount: value, service_fee_enabled: fee } });
      onDone();
    } catch (err) {
      toast.error(errMessage(err, 'Não foi possível salvar.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desconto e taxa de serviço</DialogTitle>
          <DialogDescription>Valem só para esta comanda.</DialogDescription>
        </DialogHeader>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <span className="text-sm text-foreground">Cobrar taxa de serviço ({tab.service_fee_percent}%)</span>
          <Switch checked={fee} onCheckedChange={setFee} />
        </label>
        <div className="space-y-1.5">
          <label htmlFor="discount" className="text-sm text-muted-foreground">
            Desconto em reais
          </label>
          <Input id="discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0,00" className="h-11" />
        </div>
        <DialogFooter>
          <Button className="h-11 w-full text-base" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Fechar a comanda: pagamentos
// ------------------------------------------------------------

interface DraftPayment {
  method: PaymentMethod;
  amount: number;
  tendered?: number;
}

const METHOD_ICON: Record<PaymentMethod, typeof QrCode> = {
  pix: QrCode,
  credit: CreditCard,
  debit: CreditCard,
  cash: Banknote,
  other: Wallet,
};

export function PaymentDialog({ open, tab, onClose, onDone }: { open: boolean; tab: Tab; onClose: () => void; onDone: (change: number) => void }) {
  const { fmt } = useSalao();
  const [payments, setPayments] = useState<DraftPayment[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [amountText, setAmountText] = useState('');
  const [tenderedText, setTenderedText] = useState('');
  const [busy, setBusy] = useState(false);

  const paid = useMemo(() => round2(payments.reduce((s, p) => s + p.amount, 0)), [payments]);
  const remaining = round2(tab.total - paid);
  const perPerson = tab.guests > 1 ? round2(tab.total / tab.guests) : null;

  useEffect(() => {
    if (!open) return;
     
    setPayments([]);
    setMethod('pix');
    setTenderedText('');
    setAmountText(String(tab.total).replace('.', ','));
  }, [open, tab.total]);

  function addPayment() {
    const amount = parseMoneyInput(amountText);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error('Informe o valor deste pagamento.');
      return;
    }
    if (amount > remaining + 0.005) {
      toast.error(`O valor passa do que falta (${fmt(remaining)}).`);
      return;
    }
    const draft: DraftPayment = { method, amount };
    if (method === 'cash' && tenderedText.trim()) {
      const tendered = parseMoneyInput(tenderedText);
      if (Number.isNaN(tendered) || tendered < amount) {
        toast.error('O dinheiro entregue não pode ser menor que o valor.');
        return;
      }
      draft.tendered = tendered;
    }
    const next = [...payments, draft];
    setPayments(next);
    setTenderedText('');
    const left = round2(tab.total - next.reduce((s, p) => s + p.amount, 0));
    setAmountText(left > 0 ? String(left).replace('.', ',') : '');
  }

  const tenderedValue = method === 'cash' && tenderedText.trim() ? parseMoneyInput(tenderedText) : NaN;
  const amountValue = parseMoneyInput(amountText);
  const changePreview = !Number.isNaN(tenderedValue) && !Number.isNaN(amountValue) ? round2(tenderedValue - amountValue) : null;

  async function finish() {
    setBusy(true);
    try {
      const res = await api<{ change: number }>(`/tabs/${tab.id}/close`, { body: { payments } });
      onDone(res.change);
    } catch (err) {
      toast.error(errMessage(err, 'Não foi possível fechar a comanda.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fechar {tab.label}</DialogTitle>
          <DialogDescription>
            Total {fmt(tab.total)}
            {perPerson ? ` · ${fmt(perPerson)} por pessoa (${tab.guests})` : ''}
          </DialogDescription>
        </DialogHeader>

        {payments.length > 0 ? (
          <ul className="space-y-1.5">
            {payments.map((p, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span className="text-foreground">
                  {METHOD_LABEL[p.method]}
                  {p.tendered ? <span className="text-muted-foreground"> · entregue {fmt(p.tendered)} · troco {fmt(round2(p.tendered - p.amount))}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{fmt(p.amount)}</span>
                  <button type="button" aria-label="Remover pagamento" onClick={() => setPayments(payments.filter((_, j) => j !== i))} className="text-muted-foreground">
                    <Trash2 className="size-4" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {remaining > 0.004 ? (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <p className="text-sm font-medium text-foreground">Falta receber {fmt(remaining)}</p>
            <div className="grid grid-cols-5 gap-1.5">
              {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => {
                const Icon = METHOD_ICON[m];
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    aria-pressed={method === m}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] ${method === m ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}
                  >
                    <Icon className="size-4" />
                    {METHOD_LABEL[m]}
                  </button>
                );
              })}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pay-amount" className="text-xs text-muted-foreground">
                Valor neste pagamento
              </label>
              <Input id="pay-amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} className="h-11" />
            </div>
            {method === 'cash' ? (
              <div className="space-y-1.5">
                <label htmlFor="pay-tendered" className="text-xs text-muted-foreground">
                  Dinheiro entregue pelo cliente (opcional, para o troco)
                </label>
                <Input id="pay-tendered" inputMode="decimal" value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} className="h-11" />
                {changePreview !== null && changePreview >= 0 ? (
                  <p className="text-sm font-semibold text-foreground">Troco: {fmt(changePreview)}</p>
                ) : null}
              </div>
            ) : null}
            <Button variant="outline" className="h-11 w-full" onClick={addPayment}>
              <Plus className="size-4" />
              Adicionar pagamento
            </Button>
          </div>
        ) : null}

        <DialogFooter>
          <Button className="h-12 w-full text-base" disabled={busy || remaining > 0.004 || remaining < -0.004} onClick={() => void finish()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {tab.total === 0 ? 'Fechar sem cobrança' : 'Concluir e fechar comanda'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
