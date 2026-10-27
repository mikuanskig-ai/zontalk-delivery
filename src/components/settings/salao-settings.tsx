'use client';

// Configurações > Salão. Mesas, equipe, aparelhos e as regras (taxa de
// serviço, caixa e quem pode o quê). Só admin+ chega aqui; as rotas
// /api/salao/admin/* conferem de novo no servidor.

import { useEffect, useState } from 'react';
import { Loader2, Printer, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/components/salao/api';
import type { SalaoAction, SalaoRole } from '@/lib/salao/permissions';
import { SettingsPanelHead } from './settings-panel-head';
import { DevicesPanel, StaffPanel, TablesPanel } from './salao-settings-parts';

interface RulesResponse {
  settings: { service_fee_percent: number; service_fee_default_on: boolean; require_open_cash: boolean };
  permissions: Record<SalaoRole, Record<SalaoAction, boolean>>;
  meta: { actions: { key: SalaoAction; label: string }[]; configurable_roles: SalaoRole[] };
  printing: { enabled: boolean; last_polled_at: string | null; last_polled_caixa_at: string | null };
}

const TABS = [
  { id: 'tables', label: 'Mesas' },
  { id: 'staff', label: 'Equipe' },
  { id: 'devices', label: 'Aparelhos' },
  { id: 'rules', label: 'Regras e permissões' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const ROLE_LABEL: Record<string, string> = { garcom: 'Garçom', caixa: 'Caixa', gerente: 'Gerente' };

/** O agente consulta a fila a cada poucos segundos; mais que isto sem notícia = parado. */
const AGENT_FRESH_MS = 2 * 60 * 1000;

function fresh(iso: string | null): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() < AGENT_FRESH_MS;
}

function RulesPanel() {
  const [data, setData] = useState<RulesResponse | null>(null);
  const [fee, setFee] = useState('10');
  const [feeDefaultOn, setFeeDefaultOn] = useState(true);
  const [requireCash, setRequireCash] = useState(true);
  const [matrix, setMatrix] = useState<RulesResponse['permissions'] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<RulesResponse>('/admin/settings')
      .then((res) => {
        setData(res);
        setFee(String(res.settings.service_fee_percent).replace('.', ','));
        setFeeDefaultOn(res.settings.service_fee_default_on);
        setRequireCash(res.settings.require_open_cash);
        setMatrix(res.permissions);
      })
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível carregar.'));
  }, []);

  if (!data || !matrix) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  async function save() {
    const percent = Number(fee.replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      toast.error('A taxa de serviço deve ficar entre 0 e 100.');
      return;
    }
    setSaving(true);
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: { service_fee_percent: percent, service_fee_default_on: feeDefaultOn, require_open_cash: requireCash, permissions: matrix },
      });
      toast.success('Regras salvas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  const printing = data.printing;
  const agentOk = fresh(printing.last_polled_at);
  const caixaOk = fresh(printing.last_polled_caixa_at);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Printer className="size-4 text-primary" />
            Impressoras
          </CardTitle>
          <CardDescription>
            Os pedidos das mesas saem na impressora da cozinha. A conta e o fechamento do caixa saem na impressora do caixa. Para isso, use o Print Agent versão 1.5.0 ou mais nova.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!printing.enabled ? (
            <p className="text-foreground">A impressão automática está desligada. Ligue em Configurações &gt; Impressão automática.</p>
          ) : (
            <>
              <p className="text-foreground">
                Cozinha: {agentOk ? 'Print Agent conectado.' : 'o Print Agent não aparece conectado agora. Abra o programa no computador da cozinha.'}
              </p>
              <p className="text-foreground">
                Caixa: {caixaOk ? 'impressora do caixa conectada.' : 'nenhum Print Agent com impressora de caixa apareceu. A conta e o relatório ficam esperando; use a versão 1.5.0 e marque a impressora do caixa (ou use a mesma da cozinha).'}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Taxa de serviço e caixa</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block max-w-xs space-y-1 text-sm">
            <span className="text-muted-foreground">Taxa de serviço (%)</span>
            <Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
            <span className="text-foreground">Cobrar a taxa de serviço por padrão nas mesas (a venda de balcão nunca cobra)</span>
            <Switch checked={feeDefaultOn} onCheckedChange={setFeeDefaultOn} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
            <span className="text-foreground">Só receber pagamentos com o caixa aberto</span>
            <Switch checked={requireCash} onCheckedChange={setRequireCash} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            Quem pode o quê
          </CardTitle>
          <CardDescription>O gerente sempre pode tudo. Marque o que cada função pode fazer no seu restaurante.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Ação</th>
                  {data.meta.configurable_roles.map((r) => (
                    <th key={r} className="px-3 py-2 text-center font-medium">
                      {ROLE_LABEL[r]}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center font-medium">Gerente</th>
                </tr>
              </thead>
              <tbody>
                {data.meta.actions.map((a) => {
                  const fixed = a.key === 'reopen_tab';
                  return (
                    <tr key={a.key} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-3 text-foreground">{a.label}</td>
                      {data.meta.configurable_roles.map((r) => (
                        <td key={r} className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--primary)]"
                            aria-label={`${ROLE_LABEL[r]} pode: ${a.label}`}
                            checked={!fixed && matrix[r][a.key]}
                            disabled={fixed}
                            onChange={(e) => setMatrix({ ...matrix, [r]: { ...matrix[r], [a.key]: e.target.checked } })}
                          />
                        </td>
                      ))}
                      <td className="px-3 py-2.5 text-center">
                        <input type="checkbox" className="size-4" checked disabled aria-label={`Gerente pode: ${a.label}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Button disabled={saving} onClick={() => void save()}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : null}
        Salvar regras
      </Button>
    </div>
  );
}

export function SalaoSettings() {
  const [tab, setTab] = useState<TabId>('tables');

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Salão"
        description="Mesas, comandas, garçom pelo celular e caixa. O garçom e o caixa usam o endereço /salao no celular ou no computador."
      />
      <div role="tablist" aria-label="Seções do salão" className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${tab === t.id ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tables' ? <TablesPanel /> : null}
      {tab === 'staff' ? <StaffPanel /> : null}
      {tab === 'devices' ? <DevicesPanel /> : null}
      {tab === 'rules' ? <RulesPanel /> : null}
    </section>
  );
}
