import type { Metadata, Viewport } from 'next';

// Layout próprio do app do salão: sem o menu lateral do painel. O app
// pode ser adicionado à tela inicial do celular (manifest) e abre em
// tela cheia, como um aplicativo.
export const metadata: Metadata = {
  title: 'Salão',
  manifest: '/salao.webmanifest',
  appleWebApp: { capable: true, title: 'Salão', statusBarStyle: 'default' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function SalaoLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
