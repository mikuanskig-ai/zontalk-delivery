'use client';

// Relatório de um caixa para imprimir pelo navegador (quando o restaurante
// ainda não tem o Print Agent com impressora de caixa). Fora do layout do
// painel, no mesmo estilo da página de impressão de pedido.

import { use, useEffect, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import type { CashReportTicket, DeliveryMethodKey, PaymentMethodKey } from '@/lib/salao/tickets';
import { ApiError, api } from '@/components/salao/api';
import { money } from '@/components/salao/format';
import { METHOD_LABEL } from '@/components/salao/types';

const DELIVERY_LABEL: Record<DeliveryMethodKey, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  card: 'Cartão',
  other: 'Outros',
  unknown: 'Sem forma informada',
};

function dt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function CashReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ report: CashReportTicket; account_name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ report: CashReportTicket; account_name: string }>(`/cash/${id}/report`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o relatório.'));
  }, [id]);

  if (error) return <p className="p-6 text-center text-sm">{error}</p>;
  if (!data) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const r = data.report;
  const m = (v: number) => money(v, r.currency);

  return (
    <main className="mx-auto max-w-md bg-white p-6 font-mono text-sm text-black print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg border border-black/20 px-4 py-2 text-sm">
          <Printer className="size-4" />
          Imprimir
        </button>
      </div>

      <h1 className="text-center text-base font-bold">{data.account_name}</h1>
      <p className="text-center">FECHAMENTO DO CAIXA</p>
      <p className="text-center text-xs">NÃO É DOCUMENTO FISCAL</p>
      <hr className="my-3 border-black" />

      <Line label="Aberto" value={dt(r.opened_at)} />
      <Line label="por" value={r.opened_by} />
      <Line label="Fechado" value={dt(r.closed_at)} />
      <Line label="por" value={r.closed_by ?? '—'} />
      <hr className="my-3 border-black" />

      <p className="font-bold">SALÃO E BALCÃO</p>
      <Line label={`${r.salao_tabs_count} comanda(s)`} value={m(r.salao_total)} bold />
      {(Object.keys(r.salao_by_method) as PaymentMethodKey[])
        .filter((k) => r.salao_by_method[k] > 0)
        .map((k) => (
          <Line key={k} label={`  ${METHOD_LABEL[k]}`} value={m(r.salao_by_method[k])} />
        ))}
      <hr className="my-3 border-black" />

      <p className="font-bold">DELIVERY (a conferir)</p>
      <Line label={`${r.delivery_orders_count} pedido(s)`} value={m(r.delivery_total)} bold />
      {(Object.keys(r.delivery_by_method) as DeliveryMethodKey[])
        .filter((k) => r.delivery_by_method[k].count > 0)
        .map((k) => (
          <Line key={k} label={`  ${DELIVERY_LABEL[k]} (${r.delivery_by_method[k].count})`} value={m(r.delivery_by_method[k].total)} />
        ))}
      <hr className="my-3 border-black" />

      <p className="font-bold">DINHEIRO DA GAVETA</p>
      <Line label="Fundo de troco" value={m(r.opening_float)} />
      <Line label="+ Dinheiro recebido" value={m(r.salao_by_method.cash)} />
      <Line label="+ Suprimentos" value={m(r.supply_total)} />
      <Line label="− Sangrias" value={m(r.withdrawal_total)} />
      <Line label="Esperado" value={r.expected_cash == null ? '—' : m(r.expected_cash)} bold />
      <Line label="Contado" value={r.counted_cash == null ? '—' : m(r.counted_cash)} bold />
      <Line label={r.difference != null && r.difference < 0 ? 'FALTOU' : 'Sobrou'} value={r.difference == null ? '—' : m(Math.abs(r.difference))} bold />

      {r.movements.length > 0 ? (
        <>
          <hr className="my-3 border-black" />
          <p className="font-bold">MOVIMENTOS</p>
          {r.movements.map((mv, i) => (
            <div key={i}>
              <Line label={`${mv.kind === 'withdrawal' ? 'Sangria' : 'Suprimento'} · ${mv.by_name}`} value={m(mv.amount)} />
              {mv.reason ? <p className="pl-2 text-xs">{mv.reason}</p> : null}
            </div>
          ))}
        </>
      ) : null}
      {r.notes ? (
        <>
          <hr className="my-3 border-black" />
          <p className="font-bold">OBSERVAÇÃO</p>
          <p>{r.notes}</p>
        </>
      ) : null}
    </main>
  );
}
