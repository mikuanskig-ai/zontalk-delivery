// Cliente das rotas /api/salao/* para o app do salão (celular do garçom).
//
// Toda chamada devolve JSON ou lança ApiError com o `code` estável da
// rota (ex.: 'forbidden', 'tab_not_open', 'pin_required'). Quando o
// servidor diz que a sessão acabou (pin_required / device_required), o
// app inteiro é avisado por um evento, e a tela volta sozinha para o PIN.

import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const AUTH_LOST_EVENT = 'salao:auth-lost';

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/salao${path}`, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com a internet. Confira o sinal e tente de novo.');
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return data as T;

  const code = typeof data?.error === 'string' ? data.error : 'error';
  const message = typeof data?.message === 'string' ? data.message : 'Algo deu errado. Tente de novo.';
  if (res.status === 401 && (code === 'pin_required' || code === 'device_required') && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  }
  throw new ApiError(res.status, code, message, data ?? undefined);
}

/**
 * Consulta uma rota de tempos em tempos (os aparelhos do salão não têm
 * sessão do Supabase, então não há realtime). Pausa com a aba escondida
 * e atualiza na hora em que ela volta. `reload()` força uma consulta.
 */
export function usePoll<T>(path: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  const inFlight = useRef(false);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (!current || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api<T>(current);
      if (pathRef.current === current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (pathRef.current === current) setError(err instanceof ApiError ? err : new ApiError(0, 'error', 'Erro ao atualizar.'));
    } finally {
      inFlight.current = false;
      if (pathRef.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
     
    setLoading(true);
    setData(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, intervalMs, load]);

  return { data, error, loading, reload: load };
}
