'use client';

// Telas de acesso do app do salão: conectar o aparelho (código de 6
// dígitos gerado pelo dono) e digitar o PIN do funcionário.

import { useState } from 'react';
import { Delete, Loader2, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from './api';

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <header className="space-y-1 text-center">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Salão</p>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </header>
      {children}
    </main>
  );
}

/** Teclado numérico grande, no estilo de uma maquininha. */
function Keypad({ value, maxLength, onChange, disabled }: { value: string; maxLength: number; onChange: (v: string) => void; disabled?: boolean }) {
  const press = (digit: string) => {
    if (disabled || value.length >= maxLength) return;
    onChange(value + digit);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div className="grid grid-cols-3 gap-3">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          onClick={() => press(k)}
          className="h-16 rounded-2xl border border-border bg-card text-2xl font-medium text-foreground transition active:scale-95 active:bg-muted disabled:opacity-50"
        >
          {k}
        </button>
      ))}
      <span />
      <button
        type="button"
        disabled={disabled}
        onClick={() => press('0')}
        className="h-16 rounded-2xl border border-border bg-card text-2xl font-medium text-foreground transition active:scale-95 active:bg-muted disabled:opacity-50"
      >
        0
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-label="Apagar"
        onClick={() => onChange(value.slice(0, -1))}
        className="flex h-16 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground transition active:scale-95 active:bg-muted disabled:opacity-50"
      >
        <Delete className="size-6" />
      </button>
    </div>
  );
}

export function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value: string) {
    setBusy(true);
    setError(null);
    try {
      await api('/connect', { body: { code: value } });
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível conectar.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Conectar este celular" subtitle="Peça ao responsável o código de 6 números em Configurações > Salão > Aparelhos.">
      <div className="flex justify-center gap-2" aria-live="polite">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className="flex h-12 w-10 items-center justify-center rounded-lg border border-border bg-card text-xl font-semibold text-foreground"
          >
            {code[i] ?? ''}
          </span>
        ))}
      </div>
      {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
      <Keypad
        value={code}
        maxLength={6}
        disabled={busy}
        onChange={(v) => {
          setCode(v);
          setError(null);
        }}
      />
      <Button size="lg" className="h-12 text-base" disabled={busy || code.length !== 6} onClick={() => void submit(code)}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" />}
        Conectar
      </Button>
    </Shell>
  );
}

export function PinScreen({ accountName, onDone }: { accountName: string; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/pin', { body: { pin } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Digite seu PIN" subtitle={accountName || undefined}>
      <div className="flex justify-center gap-3" aria-live="polite">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={`size-4 rounded-full border ${i < pin.length ? 'border-primary bg-primary' : 'border-border bg-card'}`}
          />
        ))}
      </div>
      {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
      <Keypad
        value={pin}
        maxLength={6}
        disabled={busy}
        onChange={(v) => {
          setPin(v);
          setError(null);
        }}
      />
      <Button size="lg" className="h-12 text-base" disabled={busy || pin.length < 4} onClick={() => void submit()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Entrar
      </Button>
    </Shell>
  );
}
