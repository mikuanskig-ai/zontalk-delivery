// ============================================================
// GET /api/salao/admin/qr — o QR de cada mesa (SVG) para imprimir.
// O QR aponta para /m/<código-da-mesa> neste mesmo site.
// ============================================================

import QRCode from 'qrcode';
import { NextResponse } from 'next/server';
import { requireSalaoAdmin, salaoErrorResponse } from '@/lib/salao/context';

function siteOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  try {
    const admin = await requireSalaoAdmin();
    const { data } = await admin.db
      .from('salao_tables')
      .select('id, number, name, area, qr_token')
      .eq('account_id', admin.accountId)
      .eq('is_active', true)
      .order('position')
      .order('number');

    const origin = siteOrigin(request);
    const tables = await Promise.all(
      (data ?? []).map(async (t) => {
        const url = `${origin}/m/${t.qr_token}`;
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return { id: t.id, number: t.number, name: t.name, area: t.area, url, svg };
      }),
    );
    return NextResponse.json({ account_name: admin.account.name, tables });
  } catch (err) {
    return salaoErrorResponse(err);
  }
}
