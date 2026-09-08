'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Printer, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface TestItem {
  product_name: string;
  quantity: string;
  unit_price: string;
  notes: string;
}

function emptyItem(): TestItem {
  return { product_name: '', quantity: '1', unit_price: '0', notes: '' };
}

// Mirrors the mockup scenario used to design the redesigned template
// (0.24.0) — a realistic multi-item order with an addon and a note,
// good enough to eyeball spacing/wrapping without typing from scratch.
function sampleItems(): TestItem[] {
  return [
    { product_name: 'X-Burger Especial', quantity: '1', unit_price: '35', notes: 'Sem cebola' },
    { product_name: 'Batata Frita G', quantity: '2', unit_price: '20', notes: '' },
    { product_name: 'Coca-Cola Lata 350ml', quantity: '1', unit_price: '6', notes: '' },
  ];
}

// Polls up to this long before telling the user the agent looks
// offline — the agent's own poll interval is a few seconds (README),
// so a real agent online should ack well within this window.
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

type TestStatus = 'idle' | 'sending' | 'waiting' | 'printed' | 'failed' | 'timeout';

export function PrintTestSimulator() {
  const t = useTranslations('Settings.printing.simulator');

  const [items, setItems] = useState<TestItem[]>([emptyItem()]);
  const [customerName, setCustomerName] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [notes, setNotes] = useState('');

  const [status, setStatus] = useState<TestStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function fillSample() {
    setItems(sampleItems());
    setCustomerName('João da Silva');
    setDeliveryAddress('Rua das Flores, 123 - Apto 42, Centro');
    setPaymentMethod('Pix');
    setPaymentNotes('');
    setNotes('Favor enviar 2 sachês de maionese');
  }

  function updateItem(index: number, patch: Partial<TestItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function pollStatus(orderId: string) {
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      if (Date.now() > pollDeadlineRef.current) {
        stopPolling();
        setStatus('timeout');
        return;
      }
      try {
        const res = await fetch(`/api/delivery/print-test/${orderId}`, { cache: 'no-store' });
        if (!res.ok) return; // transient — keep polling until the timeout
        const data = await res.json();
        if (data.status === 'printed') {
          stopPolling();
          setStatus('printed');
        } else if (data.status === 'failed') {
          stopPolling();
          setStatus('failed');
          setStatusDetail(typeof data.error === 'string' ? data.error : null);
        }
        // 'pending'/'claimed' — still waiting, loop continues.
      } catch {
        // network blip — keep polling until the timeout
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleSubmit() {
    const validItems = items
      .filter((it) => it.product_name.trim())
      .map((it) => ({
        product_name: it.product_name.trim(),
        quantity: Math.max(1, Math.trunc(Number(it.quantity)) || 1),
        unit_price: Math.max(0, Number(it.unit_price)) || 0,
        notes: it.notes.trim() || undefined,
      }));
    if (validItems.length === 0) {
      toast.error(t('toastItemRequired'));
      return;
    }

    setStatus('sending');
    setStatusDetail(null);
    try {
      const res = await fetch('/api/delivery/print-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: validItems,
          customer_name: customerName.trim() || undefined,
          delivery_address: deliveryAddress.trim() || undefined,
          payment_method: paymentMethod.trim() || undefined,
          payment_notes: paymentNotes.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('failed');
        setStatusDetail(data?.error ?? null);
        toast.error(data?.error ?? t('toastSendFailed'));
        return;
      }
      setStatus('waiting');
      pollStatus(data.order_id);
    } catch {
      setStatus('failed');
      toast.error(t('toastSendFailed'));
    }
  }

  const sending = status === 'sending';
  const waiting = status === 'waiting';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Printer className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={fillSample}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {t('fillSample')}
          </Button>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t('items')}</Label>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-[1fr_4rem_5rem_auto] items-start gap-1.5">
              <Input
                value={item.product_name}
                onChange={(e) => updateItem(i, { product_name: e.target.value })}
                placeholder={t('itemNamePlaceholder')}
              />
              <Input
                type="number"
                min={1}
                value={item.quantity}
                onChange={(e) => updateItem(i, { quantity: e.target.value })}
                title={t('itemQuantity')}
              />
              <Input
                type="number"
                step="0.01"
                min={0}
                value={item.unit_price}
                onChange={(e) => updateItem(i, { unit_price: e.target.value })}
                title={t('itemUnitPrice')}
              />
              <button
                type="button"
                onClick={() => removeItem(i)}
                disabled={items.length === 1}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-400 disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <Input
                value={item.notes}
                onChange={(e) => updateItem(i, { notes: e.target.value })}
                placeholder={t('itemNotesPlaceholder')}
                className="col-span-3"
              />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addItem} className="justify-self-start">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('addItem')}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('customerName')}</Label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t('customerNamePlaceholder')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('deliveryAddress')}</Label>
            <Input
              value={deliveryAddress}
              onChange={(e) => setDeliveryAddress(e.target.value)}
              placeholder={t('deliveryAddressPlaceholder')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('paymentMethod')}</Label>
            <Input
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder={t('paymentMethodPlaceholder')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t('paymentNotes')}</Label>
            <Input
              value={paymentNotes}
              onChange={(e) => setPaymentNotes(e.target.value)}
              placeholder={t('paymentNotesPlaceholder')}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t('notes')}</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-[60px]"
            placeholder={t('notesPlaceholder')}
          />
        </div>

        <div className="flex items-center gap-3 border-t border-border/50 pt-4">
          <Button type="button" onClick={handleSubmit} disabled={sending || waiting}>
            {(sending || waiting) && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t('submit')}
          </Button>
          <StatusBadge status={status} detail={statusDetail} t={t} />
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  status,
  detail,
  t,
}: {
  status: TestStatus;
  detail: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  if (status === 'idle') return null;
  const map: Record<Exclude<TestStatus, 'idle'>, { label: string; className: string }> = {
    sending: { label: t('statusSending'), className: 'text-muted-foreground' },
    waiting: { label: t('statusWaiting'), className: 'text-amber-500' },
    printed: { label: t('statusPrinted'), className: 'text-emerald-500' },
    failed: { label: t('statusFailed'), className: 'text-red-400' },
    timeout: { label: t('statusTimeout'), className: 'text-red-400' },
  };
  const { label, className } = map[status];
  return (
    <div className={cn('text-sm font-medium', className)}>
      {label}
      {detail && <span className="ml-1 text-xs font-normal text-muted-foreground">({detail})</span>}
    </div>
  );
}
