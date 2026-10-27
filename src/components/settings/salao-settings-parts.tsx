'use client';

// Painéis de Configurações > Salão: mesas, equipe e aparelhos. Falam
// com /api/salao/admin/* (só admin+ do painel).

import { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, Loader2, Plus, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/components/salao/api';

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function useAdminList<T>(path: string, key: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const reload = useCallback(async () => {
    try {
      const data = await api<Record<string, unknown>>(path);
      setItems((data[key] as T[]) ?? []);
      setExtra(data);
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível carregar.'));
      setItems((prev) => prev ?? []);
    }
  }, [path, key]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial
    void reload();
  }, [reload]);
  return { items, extra, reload };
}

function Loading() {
  return (
    <div className="flex justify-center py-10 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

// ------------------------------------------------------------
// Mesas
// ------------------------------------------------------------

interface TableRow {
  id: string;
  number: number;
  name: string | null;
  area: string | null;
  is_active: boolean;
  has_open_tab: boolean;
}

export function TablesPanel() {
  const { items, reload } = useAdminList<TableRow>('/admin/tables', 'tables');
  const [count, setCount] = useState('10');
  const [start, setStart] = useState('1');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await api<{ created: number }>('/admin/tables', { body: { count: Number(count), start: Number(start), area } });
      toast.success(`${res.created} mesa${res.created === 1 ? '' : 's'} criada${res.created === 1 ? '' : 's'}.`);
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível criar as mesas.'));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/admin/tables/${id}`, { method: 'PATCH', body });
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível salvar.'));
      await reload();
    }
  }

  async function remove(row: TableRow) {
    if (!window.confirm(`Remover a mesa ${row.number}? Se ela já teve comandas, será apenas desativada.`)) return;
    try {
      const res = await api<{ deactivated: boolean }>(`/admin/tables/${row.id}`, { method: 'DELETE' });
      toast.success(res.deactivated ? 'Mesa desativada (tem histórico).' : 'Mesa removida.');
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível remover.'));
    }
  }

  async function rotateQr(row: TableRow) {
    if (!window.confirm(`Trocar o QR code da mesa ${row.number}? O QR já impresso deixa de funcionar.`)) return;
    try {
      await api(`/admin/tables/${row.id}/rotate-qr`, { method: 'POST' });
      toast.success('QR trocado. Imprima o novo.');
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível trocar o QR.'));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Criar mesas</CardTitle>
          <CardDescription>Cada mesa tem a sua comanda e o seu QR code. Crie várias de uma vez.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Quantas mesas</span>
              <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Começar no número</span>
              <Input inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Área (opcional)</span>
              <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Salão, Varanda..." />
            </label>
          </div>
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Criar mesas
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Mesas do restaurante</CardTitle>
            <CardDescription>Renomeie, mude de área, desative ou troque o QR code.</CardDescription>
          </div>
          <a
            href="/delivery/salao-qr"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-foreground hover:bg-muted"
          >
            <QrCode className="size-4" />
            Imprimir QR codes
          </a>
        </CardHeader>
        <CardContent>
          {!items ? (
            <Loading />
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma mesa ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((row) => (
                <li key={row.id} className="grid gap-2 py-3 sm:grid-cols-[3rem_1fr_1fr_auto] sm:items-center">
                  <span className="text-lg font-semibold text-foreground">{row.number}</span>
                  <Input
                    defaultValue={row.name ?? ''}
                    placeholder="Nome (opcional)"
                    aria-label={`Nome da mesa ${row.number}`}
                    onBlur={(e) => {
                      if ((e.target.value || '') !== (row.name ?? '')) void patch(row.id, { name: e.target.value });
                    }}
                  />
                  <Input
                    defaultValue={row.area ?? ''}
                    placeholder="Área"
                    aria-label={`Área da mesa ${row.number}`}
                    onBlur={(e) => {
                      if ((e.target.value || '') !== (row.area ?? '')) void patch(row.id, { area: e.target.value });
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <Switch checked={row.is_active} onCheckedChange={(on) => void patch(row.id, { is_active: on })} aria-label={`Mesa ${row.number} ativa`} />
                    <Button variant="outline" size="icon" aria-label={`Trocar o QR da mesa ${row.number}`} onClick={() => void rotateQr(row)}>
                      <RefreshCw className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`Remover a mesa ${row.number}`} onClick={() => void remove(row)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------
// Equipe
// ------------------------------------------------------------

interface StaffRow {
  id: string;
  name: string;
  role: 'garcom' | 'caixa' | 'gerente';
  is_active: boolean;
}

const ROLE_LABEL = { garcom: 'Garçom', caixa: 'Caixa', gerente: 'Gerente' } as const;

export function StaffPanel() {
  const { items, reload } = useAdminList<StaffRow>('/admin/staff', 'staff');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRow['role']>('garcom');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [newPin, setNewPin] = useState<Record<string, string>>({});

  async function create() {
    setBusy(true);
    try {
      await api('/admin/staff', { body: { name, role, pin } });
      toast.success('Funcionário cadastrado.');
      setName('');
      setPin('');
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível cadastrar.'));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, okMessage?: string) {
    try {
      await api(`/admin/staff/${id}`, { method: 'PATCH', body });
      if (okMessage) toast.success(okMessage);
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível salvar.'));
      await reload();
    }
  }

  async function remove(row: StaffRow) {
    if (!window.confirm(`Remover ${row.name}? O histórico de comandas continua com o nome dele.`)) return;
    try {
      await api(`/admin/staff/${row.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível remover.'));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Cadastrar funcionário</CardTitle>
          <CardDescription>
            Cada pessoa entra no celular com um PIN de 4 a 6 números, só dela. O garçom lança pedidos; o caixa recebe e fecha contas; o gerente faz tudo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Nome</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Função</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as StaffRow['role'])}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              >
                {(Object.keys(ROLE_LABEL) as StaffRow['role'][]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">PIN (4 a 6 números)</span>
              <Input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
            </label>
          </div>
          <Button disabled={busy || !name.trim() || pin.length < 4} onClick={() => void create()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Cadastrar
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equipe</CardTitle>
        </CardHeader>
        <CardContent>
          {!items ? (
            <Loading />
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Ninguém cadastrado ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((row) => (
                <li key={row.id} className="grid gap-2 py-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{row.name}</p>
                    {!row.is_active ? <p className="text-xs text-muted-foreground">Desativado</p> : null}
                  </div>
                  <select
                    value={row.role}
                    onChange={(e) => void patch(row.id, { role: e.target.value })}
                    aria-label={`Função de ${row.name}`}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                  >
                    {(Object.keys(ROLE_LABEL) as StaffRow['role'][]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-1.5">
                    <Input
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="Novo PIN"
                      aria-label={`Novo PIN de ${row.name}`}
                      value={newPin[row.id] ?? ''}
                      onChange={(e) => setNewPin({ ...newPin, [row.id]: e.target.value.replace(/\D/g, '') })}
                      autoComplete="off"
                    />
                    <Button
                      variant="outline"
                      disabled={(newPin[row.id] ?? '').length < 4}
                      onClick={() => {
                        void patch(row.id, { pin: newPin[row.id] }, 'PIN trocado.');
                        setNewPin({ ...newPin, [row.id]: '' });
                      }}
                    >
                      Trocar
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={row.is_active} onCheckedChange={(on) => void patch(row.id, { is_active: on })} aria-label={`${row.name} ativo`} />
                    <Button variant="outline" size="icon" aria-label={`Remover ${row.name}`} onClick={() => void remove(row)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------
// Aparelhos
// ------------------------------------------------------------

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

export function DevicesPanel() {
  const { items, reload } = useAdminList<DeviceRow>('/admin/devices', 'devices');
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(code.expires_at).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setCode(null);
        void reload();
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [code, reload]);

  // Enquanto há um código na tela, confere se o celular já conectou.
  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(t);
  }, [code, reload]);

  const knownCount = items?.length ?? 0;
  const [countAtGeneration, setCountAtGeneration] = useState(0);
  useEffect(() => {
    if (code && knownCount > countAtGeneration) {
       
      setCode(null);
      toast.success('Celular conectado.');
    }
  }, [knownCount, countAtGeneration, code]);

  async function generate() {
    setBusy(true);
    try {
      const res = await api<{ code: string; expires_at: string }>('/admin/devices', { body: { name: name.trim() || 'Celular do salão' } });
      setCountAtGeneration(knownCount);
      setCode(res);
      setName('');
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível gerar o código.'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: DeviceRow) {
    if (!window.confirm(`Desconectar "${row.name}"? Ele só volta a funcionar com um novo código.`)) return;
    try {
      await api(`/admin/devices/${row.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(errorText(err, 'Não foi possível desconectar.'));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Conectar um celular</CardTitle>
          <CardDescription>
            No celular do garçom, abra o endereço do salão, digite o código abaixo e pronto. Depois disso ele só usa o PIN.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <Smartphone className="size-4 text-primary" />
            <span className="text-muted-foreground">Endereço do salão:</span>
            <code className="font-mono text-foreground">{typeof window !== 'undefined' ? `${window.location.origin}/salao` : '/salao'}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copiar endereço"
              onClick={() => {
                void navigator.clipboard?.writeText(`${window.location.origin}/salao`);
                toast.success('Endereço copiado.');
              }}
            >
              <Copy className="size-3.5" />
            </Button>
            <a href="/salao" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
              Abrir <ExternalLink className="size-3" />
            </a>
          </div>

          {code ? (
            <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-center">
              <p className="text-sm text-muted-foreground">Digite este código no celular</p>
              <p className="font-mono text-4xl font-bold tracking-[0.3em] text-foreground" aria-live="polite">
                {code.code}
              </p>
              <p className="text-xs text-muted-foreground">
                Vale por mais {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} e só pode ser usado uma vez.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do aparelho (ex.: Celular do Carlos)" className="max-w-xs" />
              <Button disabled={busy} onClick={() => void generate()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" />}
                Gerar código
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aparelhos conectados</CardTitle>
        </CardHeader>
        <CardContent>
          {!items ? (
            <Loading />
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhum celular conectado ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Conectado em {new Date(row.created_at).toLocaleDateString('pt-BR')}
                      {row.last_seen_at ? ` · visto por último ${new Date(row.last_seen_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => void revoke(row)}>
                    Desconectar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
