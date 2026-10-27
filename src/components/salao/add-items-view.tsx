'use client';

// Escolher itens do cardápio e enviar para a cozinha. O carrinho "a
// enviar" fica salvo no aparelho (se a internet cair, nada se perde) e o
// preço mostrado aqui é só uma estimativa — o servidor recalcula tudo.

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Minus, Plus, Search, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, api, usePoll } from './api';
import { useSalao } from './salao-context';
import type { AddonGroup, MenuProduct, MenuResponse, TabDetail } from './types';

interface CartLine {
  key: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addon_option_ids: string[];
  addon_names: string[];
  addons_total: number;
  notes: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const storageKey = (tabId: string) => `zk-salao-cart:${tabId}`;

function loadCart(tabId: string): CartLine[] {
  try {
    const raw = window.localStorage.getItem(storageKey(tabId));
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCart(tabId: string, cart: CartLine[]) {
  try {
    if (cart.length === 0) window.localStorage.removeItem(storageKey(tabId));
    else window.localStorage.setItem(storageKey(tabId), JSON.stringify(cart));
  } catch {
    // sem armazenamento: o carrinho só vale enquanto a tela estiver aberta
  }
}

function groupError(group: AddonGroup, count: number): string | null {
  const min = group.is_required ? Math.max(1, group.min_select) : group.min_select;
  if (count < min) return `Escolha ${min > 1 ? `pelo menos ${min} opções` : 'uma opção'} em "${group.name}"`;
  if (group.max_select != null && count > group.max_select) return `"${group.name}": no máximo ${group.max_select}`;
  return null;
}

function ProductDialog({
  product,
  onClose,
  onAdd,
}: {
  product: MenuProduct | null;
  onClose: () => void;
  onAdd: (line: Omit<CartLine, 'key'>) => void;
}) {
  const { fmt } = useSalao();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reinicia a cada produto
    setSelected({});
    setQuantity(1);
    setNotes('');
  }, [product?.id]);

  if (!product) return null;

  function toggle(group: AddonGroup, optionId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];
      if (group.selection_type === 'single') {
        return { ...prev, [group.id]: current[0] === optionId && !group.is_required ? [] : [optionId] };
      }
      if (current.includes(optionId)) return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      if (group.max_select != null && current.length >= group.max_select) return prev;
      return { ...prev, [group.id]: [...current, optionId] };
    });
  }

  const chosenOptions = product.addon_groups.flatMap((g) => g.options.filter((o) => (selected[g.id] ?? []).includes(o.id)));
  const addonsTotal = round2(chosenOptions.reduce((s, o) => s + o.price_delta, 0));
  const errors = product.addon_groups.map((g) => groupError(g, (selected[g.id] ?? []).length)).filter((e): e is string => !!e);
  const lineTotal = round2((product.price + addonsTotal) * quantity);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>{product.description || fmt(product.price)}</DialogDescription>
        </DialogHeader>

        {product.addon_groups.map((group) => (
          <fieldset key={group.id} className="space-y-2">
            <legend className="text-sm font-semibold text-foreground">
              {group.name}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {group.is_required ? 'obrigatório' : 'opcional'}
                {group.selection_type === 'multiple' && group.max_select ? ` · até ${group.max_select}` : ''}
              </span>
            </legend>
            <ul className="space-y-1.5">
              {group.options.map((option) => {
                const checked = (selected[group.id] ?? []).includes(option.id);
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      role={group.selection_type === 'single' ? 'radio' : 'checkbox'}
                      aria-checked={checked}
                      onClick={() => toggle(group, option.id)}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-3 text-left text-sm active:scale-[0.99] ${checked ? 'border-primary bg-primary/10' : 'border-border'}`}
                    >
                      <span className="text-foreground">{option.name}</span>
                      {option.price_delta !== 0 ? (
                        <span className="text-muted-foreground">
                          {option.price_delta > 0 ? '+' : '−'} {fmt(Math.abs(option.price_delta))}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}

        <Input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} placeholder="Observação (ex.: sem cebola)" className="h-11" />

        <div className="flex items-center justify-center gap-6">
          <Button variant="outline" size="icon-lg" aria-label="Menos um" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
            <Minus className="size-4" />
          </Button>
          <span className="w-10 text-center text-3xl font-semibold text-foreground">{quantity}</span>
          <Button variant="outline" size="icon-lg" aria-label="Mais um" onClick={() => setQuantity((q) => Math.min(99, q + 1))}>
            <Plus className="size-4" />
          </Button>
        </div>

        {errors.length > 0 ? <p className="text-center text-xs text-destructive">{errors[0]}</p> : null}

        <DialogFooter>
          <Button
            className="h-12 w-full text-base"
            disabled={errors.length > 0}
            onClick={() =>
              onAdd({
                product_id: product.id,
                product_name: product.name,
                unit_price: product.price,
                quantity,
                addon_option_ids: chosenOptions.map((o) => o.id),
                addon_names: chosenOptions.map((o) => o.name),
                addons_total: addonsTotal,
                notes: notes.trim() || null,
              })
            }
          >
            Adicionar · {fmt(lineTotal)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddItemsView({ tabId }: { tabId: string }) {
  const { fmt, back } = useSalao();
  const { data: menu, error, loading } = usePoll<MenuResponse>('/menu', 60_000);
  const { data: detail } = usePoll<TabDetail>(`/tabs/${tabId}`, 8000);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [picking, setPicking] = useState<MenuProduct | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
     
    setCart(loadCart(tabId));
  }, [tabId]);

  function update(next: CartLine[]) {
    setCart(next);
    saveCart(tabId, next);
  }

  const groups = useMemo(() => {
    const list = [...(menu?.categories ?? []).map((c) => ({ id: c.id, name: c.name, products: c.products }))];
    if ((menu?.uncategorized ?? []).length > 0) list.push({ id: 'none', name: 'Outros', products: menu!.uncategorized });
    return list.filter((g) => g.products.length > 0);
  }, [menu]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((g) => category === 'all' || g.id === category)
      .map((g) => ({ ...g, products: g.products.filter((p) => !q || p.name.toLowerCase().includes(q)) }))
      .filter((g) => g.products.length > 0);
  }, [groups, category, query]);

  function addLine(line: Omit<CartLine, 'key'>) {
    const key = `${line.product_id}|${line.addon_option_ids.slice().sort().join(',')}|${line.notes ?? ''}`;
    const existing = cart.find((l) => l.key === key);
    update(
      existing
        ? cart.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l))
        : [...cart, { ...line, key }],
    );
  }

  function onProduct(product: MenuProduct) {
    if (product.addon_groups.length === 0) {
      addLine({
        product_id: product.id,
        product_name: product.name,
        unit_price: product.price,
        quantity: 1,
        addon_option_ids: [],
        addon_names: [],
        addons_total: 0,
        notes: null,
      });
      return;
    }
    setPicking(product);
  }

  const total = round2(cart.reduce((s, l) => s + (l.unit_price + l.addons_total) * l.quantity, 0));
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  async function send() {
    setSending(true);
    try {
      const res = await api<{ round_number: number; printed: boolean }>(`/tabs/${tabId}/rounds`, {
        body: {
          items: cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity, addon_option_ids: l.addon_option_ids, notes: l.notes })),
        },
      });
      update([]);
      toast.success(res.printed ? `Rodada ${res.round_number} enviada para a cozinha.` : `Rodada ${res.round_number} lançada. A impressão está desligada nesta conta.`);
      back();
    } catch (err) {
      // Mantém o carrinho: o garçom corrige (ou tenta de novo) sem remontar.
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível enviar.');
    } finally {
      setSending(false);
    }
  }

  const closed = detail && detail.tab.status !== 'open' && detail.tab.status !== 'bill_requested';

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 space-y-2 border-b border-border bg-background/95 px-3 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button type="button" onClick={back} aria-label="Voltar" className="rounded-lg p-2 text-foreground active:bg-muted">
            <ArrowLeft className="size-5" />
          </button>
          <h1 className="flex-1 truncate text-lg font-semibold text-foreground">{detail ? `Itens · ${detail.tab.label}` : 'Itens'}</h1>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar no cardápio" className="h-11 pl-9" />
        </div>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {[{ id: 'all', name: 'Tudo' }, ...groups.map((g) => ({ id: g.id, name: g.name }))].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={category === c.id}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm ${category === c.id ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </header>

      {closed ? (
        <p className="m-4 rounded-xl border border-border bg-muted p-4 text-sm text-foreground">Esta comanda já foi fechada. Não dá para lançar mais itens.</p>
      ) : null}

      <div className="flex-1 space-y-5 px-4 py-4 pb-44">
        {loading && !menu ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : null}
        {error && !menu ? <p className="text-center text-sm text-destructive">{error.message}</p> : null}
        {menu && visible.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Nada encontrado no cardápio.</p> : null}

        {visible.map((g) => (
          <section key={g.id} className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{g.name}</h2>
            <ul className="space-y-2">
              {g.products.map((p) => {
                const inCart = cart.filter((l) => l.product_id === p.id).reduce((s, l) => s + l.quantity, 0);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={!!closed}
                      onClick={() => onProduct(p)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition active:scale-[0.99] active:bg-muted disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{p.name}</span>
                        {p.description ? <span className="line-clamp-1 block text-xs text-muted-foreground">{p.description}</span> : null}
                        <span className="block text-sm text-foreground/80">{fmt(p.price)}</span>
                      </span>
                      {inCart > 0 ? (
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{inCart}</span>
                      ) : (
                        <Plus className="size-5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {cart.length > 0 ? (
        <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 pt-3 pb-4 backdrop-blur">
          <div className="mx-auto max-w-3xl space-y-3">
            <ul className="max-h-36 space-y-1 overflow-y-auto text-sm">
              {cart.map((l) => (
                <li key={l.key} className="flex items-center gap-2">
                  <span className="flex items-center gap-1">
                    <button type="button" aria-label="Menos um" onClick={() => update(l.quantity <= 1 ? cart.filter((x) => x.key !== l.key) : cart.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity - 1 } : x)))} className="rounded-md border border-border p-1 text-muted-foreground">
                      {l.quantity <= 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
                    </button>
                    <span className="w-6 text-center font-semibold text-foreground">{l.quantity}</span>
                    <button type="button" aria-label="Mais um" onClick={() => update(cart.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(99, x.quantity + 1) } : x)))} className="rounded-md border border-border p-1 text-muted-foreground">
                      <Plus className="size-3.5" />
                    </button>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {l.product_name}
                    {l.addon_names.length > 0 ? <span className="text-muted-foreground"> · {l.addon_names.join(', ')}</span> : null}
                    {l.notes ? <span className="text-muted-foreground"> · “{l.notes}”</span> : null}
                  </span>
                  <span className="text-foreground/80">{fmt((l.unit_price + l.addons_total) * l.quantity)}</span>
                </li>
              ))}
            </ul>
            <Button className="h-12 w-full text-base" disabled={sending || !!closed} onClick={() => void send()}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Enviar para a cozinha · {count} {count === 1 ? 'item' : 'itens'} · {fmt(total)}
            </Button>
          </div>
        </footer>
      ) : null}

      <ProductDialog
        product={picking}
        onClose={() => setPicking(null)}
        onAdd={(line) => {
          addLine(line);
          setPicking(null);
        }}
      />
    </div>
  );
}
