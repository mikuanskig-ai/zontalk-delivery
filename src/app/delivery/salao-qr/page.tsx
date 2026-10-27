'use client';

// Folha de QR codes das mesas para imprimir (A4, 6 cartões por página).
// Fora do layout do painel, igual à página de impressão de pedido; o
// caminho /delivery já exige login (middleware) e a rota de dados exige
// admin do painel. O garçom lê o QR de dentro do app (ou com a câmera,
// se o aparelho já estiver conectado); o cliente que ler vê o cardápio.

import { useEffect, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { ApiError, api } from '@/components/salao/api';

interface QrTable {
  id: string;
  number: number;
  name: string | null;
  area: string | null;
  url: string;
  svg: string;
}

export default function SalaoQrSheetPage() {
  const [data, setData] = useState<{ account_name: string; tables: QrTable[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ account_name: string; tables: QrTable[] }>('/admin/qr')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os QR codes.'));
  }, []);

  if (error) return <p className="p-8 text-center text-sm">{error}</p>;
  if (!data) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-[210mm] bg-white p-4 text-black print:p-0">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <p className="text-sm text-black/70">
          {data.tables.length} mesa{data.tables.length === 1 ? '' : 's'} · 6 por folha A4. Cole o QR na mesa ou plastifique.
        </p>
        <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg border border-black/20 px-4 py-2 text-sm">
          <Printer className="size-4" />
          Imprimir
        </button>
      </div>

      {data.tables.length === 0 ? <p className="p-8 text-center text-sm">Nenhuma mesa ativa. Crie as mesas em Configurações &gt; Salão.</p> : null}

      <div className="grid grid-cols-2 gap-4 print:gap-0">
        {data.tables.map((t) => (
          <section
            key={t.id}
            className="flex break-inside-avoid flex-col items-center gap-2 border border-dashed border-black/30 p-6 text-center print:h-[92mm] print:justify-center"
          >
            <p className="text-sm font-medium text-black/70">{data.account_name}</p>
            <p className="text-4xl font-bold">Mesa {t.number}</p>
            {t.name || t.area ? <p className="text-xs text-black/60">{[t.name, t.area].filter(Boolean).join(' · ')}</p> : null}
            <div className="size-44 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: t.svg }} />
            <p className="max-w-full truncate text-[9px] text-black/50">{t.url}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
