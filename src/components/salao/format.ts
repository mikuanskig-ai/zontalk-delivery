// Formatação do app do salão: dinheiro com centavos (conta de restaurante
// tem centavos — o formatCurrency do painel arredonda para inteiro) e
// tempo decorrido em português.

export function money(value: number, currency: string = 'BRL'): string {
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** "12 min", "1h05" — há quanto tempo a mesa está aberta. */
export function elapsed(fromIso: string, nowMs: number = Date.now()): string {
  const ms = Math.max(0, nowMs - new Date(fromIso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "12,50" digitado pelo usuário → 12.5. Vírgula ou ponto; vazio → NaN. */
export function parseMoneyInput(raw: string): number {
  const text = raw.trim().replace(/\s/g, '');
  if (!text) return NaN;
  // Com vírgula, os pontos são separador de milhar ("1.234,56"). Sem
  // vírgula, um único ponto com 1-2 casas depois é decimal ("12.5").
  const dotIsDecimal = !text.includes(',') && /^\d+\.\d{1,2}$/.test(text);
  const cleaned = dotIsDecimal ? text : text.replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

export function addonLabel(addons: { group_name?: string; option_name?: string }[]): string[] {
  return addons
    .map((a) => (a.option_name ? (a.group_name ? `${a.group_name}: ${a.option_name}` : a.option_name) : null))
    .filter((s): s is string => !!s);
}
