// ============================================================
// /m/<código-da-mesa> — destino do QR code impresso em cada mesa.
//
//   - Garçom/caixa (aparelho conectado ou logado no painel como admin):
//     vai para o app do salão, que abre a comanda dessa mesa.
//   - Qualquer outro celular (o cliente): só vê o cardápio público, se o
//     restaurante tiver um. O QR NÃO deixa o cliente fazer pedido.
//
// O código da mesa vale para uma mesa de uma conta; um código que não
// existe mais (QR trocado) cai na mensagem genérica, sem revelar nada.
// ============================================================

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { supabaseAdmin } from '@/lib/payments/admin-client';
import { resolveActor } from '@/lib/salao/context';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Mesa', robots: { index: false, follow: false } };

export default async function TableQrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (/^[0-9a-f]{32}$/.test(token)) {
    const db = supabaseAdmin();
    const { data: table } = await db
      .from('salao_tables')
      .select('number, name, account_id, is_active')
      .eq('qr_token', token)
      .maybeSingle();

    if (table?.is_active) {
      // Reaproveita a mesma resolução das rotas do salão, lendo os cookies desta visita.
      const cookie = (await headers()).get('cookie') ?? '';
      const resolution = await resolveActor(new Request('http://localhost/m', { headers: { cookie } }));
      const staffOfThisRestaurant =
        (resolution.state === 'ok' && resolution.actor.accountId === table.account_id) ||
        (resolution.state === 'pin_required' && resolution.accountId === table.account_id);
      if (staffOfThisRestaurant) redirect(`/salao?mesa=${token}`);

      const { data: account } = await db
        .from('accounts')
        .select('name, slug, enabled_modules, status')
        .eq('id', table.account_id)
        .maybeSingle();

      const hasMenu = !!account?.slug && account.status !== 'suspended' && (account.enabled_modules ?? []).includes('delivery');
      if (account?.slug && hasMenu) redirect(`/c/${account.slug}`);

      return (
        <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-muted-foreground">{account?.name}</p>
          <h1 className="text-3xl font-semibold text-foreground">Mesa {table.number}</h1>
          <p className="text-muted-foreground">Chame o garçom para fazer seu pedido.</p>
        </main>
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">QR code indisponível</h1>
      <p className="text-muted-foreground">Chame o garçom para fazer seu pedido.</p>
    </main>
  );
}
