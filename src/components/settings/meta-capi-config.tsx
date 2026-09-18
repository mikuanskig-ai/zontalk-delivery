'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Loader2, Megaphone, Send } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { SettingsPanelHead } from './settings-panel-head';

interface Asset {
  id: string;
  name: string;
}

interface MetaCapiState {
  configured: boolean;
  platform_ready: boolean;
  platform_business_id: string | null;
  pixel_id?: string | null;
  pixel_name?: string | null;
  whatsapp_business_account_id?: string | null;
  whatsapp_business_account_name?: string | null;
  is_active?: boolean;
  test_event_code?: string | null;
}

/**
 * "Meta Ads (CTWA)" — fecha o funil de anúncio Clique-para-WhatsApp via
 * Meta Conversions API. Modelo "parceiro" (2026-09-18, pedido do Eder):
 * nenhum campo de Pixel ID ou token pra o tenant digitar — ele só
 * compartilha o Pixel/WABA com o Business Manager da plataforma (um
 * clique do lado dele, fora daqui) e escolhe qual é o dele numa lista
 * auto-descoberta via API (ver discover-assets.ts).
 */
export function MetaCapiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.metaCapi');
  const { confirm, dialog } = useConfirmDialog();

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<MetaCapiState | null>(null);
  const [copied, setCopied] = useState(false);

  const [searching, setSearching] = useState(false);
  const [pixels, setPixels] = useState<Asset[] | null>(null);
  const [wabas, setWabas] = useState<Asset[] | null>(null);
  const [pickedPixel, setPickedPixel] = useState<string>('');
  const [pickedWaba, setPickedWaba] = useState<string>('');
  const [linking, setLinking] = useState(false);

  const [savingActive, setSavingActive] = useState(false);
  const [testEventCode, setTestEventCode] = useState('');
  const [savingCode, setSavingCode] = useState(false);
  const [testing, setTesting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/meta-capi', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      setState(data);
      setTestEventCode(data.test_event_code ?? '');
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    setLoading(true);
    void fetchConfig();
  }, [accountId, fetchConfig]);

  async function handleCopyBusinessId() {
    if (!state?.platform_business_id) return;
    await navigator.clipboard.writeText(state.platform_business_id);
    setCopied(true);
    toast.success(t('copiedToast'));
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSearch() {
    setSearching(true);
    setPixels(null);
    setWabas(null);
    try {
      const res = await fetch('/api/integrations/meta-capi/available-assets');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('searchFailed'));
        return;
      }
      setPixels(data.pixels ?? []);
      setWabas(data.whatsapp_business_accounts ?? []);
    } catch {
      toast.error(t('searchFailed'));
    } finally {
      setSearching(false);
    }
  }

  async function handleLink() {
    const pixel = pixels?.find((p) => p.id === pickedPixel);
    const waba = wabas?.find((w) => w.id === pickedWaba);
    if (!pixel || !waba) return;

    setLinking(true);
    try {
      const res = await fetch('/api/integrations/meta-capi/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pixel_id: pixel.id,
          pixel_name: pixel.name,
          whatsapp_business_account_id: waba.id,
          whatsapp_business_account_name: waba.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('linkFailed'));
        return;
      }
      toast.success(t('linkSuccess'));
      setPixels(null);
      setWabas(null);
      await fetchConfig();
    } catch {
      toast.error(t('linkFailed'));
    } finally {
      setLinking(false);
    }
  }

  async function handleToggleActive(next: boolean) {
    setState((prev) => (prev ? { ...prev, is_active: next } : prev));
    setSavingActive(true);
    try {
      const res = await fetch('/api/integrations/meta-capi', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
      } else {
        setState((prev) => (prev ? { ...prev, is_active: !next } : prev));
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      setState((prev) => (prev ? { ...prev, is_active: !next } : prev));
      toast.error(t('saveFailed'));
    } finally {
      setSavingActive(false);
    }
  }

  async function handleSaveTestCode() {
    setSavingCode(true);
    try {
      const res = await fetch('/api/integrations/meta-capi', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_event_code: testEventCode.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSavingCode(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/integrations/meta-capi/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('testFailed'));
        return;
      }
      toast.success(t('testSuccess'));
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function handleUnlink() {
    const ok = await confirm({
      title: t('unlinkConfirmTitle'),
      description: t('unlinkConfirmDesc'),
      confirmLabel: t('unlinkButton'),
      destructive: true,
    });
    if (!ok) return;

    setUnlinking(true);
    try {
      const res = await fetch('/api/integrations/meta-capi', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('unlinkFailed'));
        return;
      }
      toast.success(t('unlinkSuccess'));
      await fetchConfig();
    } catch {
      toast.error(t('unlinkFailed'));
    } finally {
      setUnlinking(false);
    }
  }

  if (loading || profileLoading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const isLinked = !!(state?.pixel_id && state.whatsapp_business_account_id);

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      {dialog}
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground text-base">
            <Megaphone className="size-4 text-primary" /> {t('howItWorksTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">{t('howItWorksDesc')}</CardDescription>
        </CardHeader>
      </Card>

      {!state?.platform_ready && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">{t('platformNotReady')}</CardContent>
        </Card>
      )}

      {state?.platform_ready && !isLinked && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">{t('step1Title')}</CardTitle>
              <CardDescription className="text-muted-foreground">{t('step1Desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('businessIdLabel')}</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={state.platform_business_id ?? ''} className="font-mono" />
                <Button type="button" variant="outline" size="icon" onClick={handleCopyBusinessId}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          {canEdit && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground text-base">{t('step2Title')}</CardTitle>
                <CardDescription className="text-muted-foreground">{t('step2Desc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button type="button" variant="outline" onClick={handleSearch} disabled={searching}>
                  {searching ? <Loader2 className="size-4 animate-spin" /> : null}
                  {searching ? t('searching') : t('searchButton')}
                </Button>

                {pixels !== null && wabas !== null && (
                  pixels.length === 0 && wabas.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('noAssetsFound')}</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('pixelLabel')}</p>
                        <Select value={pickedPixel} onValueChange={(v) => setPickedPixel(v ?? '')}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('selectPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {pixels.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name} ({p.id})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('wabaLabel')}</p>
                        <Select value={pickedWaba} onValueChange={(v) => setPickedWaba(v ?? '')}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('selectPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {wabas.map((w) => (
                              <SelectItem key={w.id} value={w.id}>
                                {w.name} ({w.id})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="sm:col-span-2">
                        <Button
                          type="button"
                          onClick={handleLink}
                          disabled={linking || !pickedPixel || !pickedWaba}
                        >
                          {linking ? <Loader2 className="size-4 animate-spin" /> : null}
                          {linking ? t('linking') : t('linkButton')}
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {isLinked && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground text-base">
              {t('linkedTitle')}
              <Badge variant={state?.is_active ? 'secondary' : 'outline'}>
                {state?.is_active ? t('activeLabel') : t('inactiveLabel')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <p className="text-muted-foreground">{t('pixelLabel')}</p>
                <p className="text-foreground">{state?.pixel_name} ({state?.pixel_id})</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t('wabaLabel')}</p>
                <p className="text-foreground">
                  {state?.whatsapp_business_account_name} ({state?.whatsapp_business_account_id})
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('activeLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('activeDesc')}</p>
              </div>
              <Switch
                checked={!!state?.is_active}
                onCheckedChange={handleToggleActive}
                disabled={!canEdit || savingActive}
              />
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('testEventCodeLabel')}</p>
              <div className="flex items-center gap-2">
                <Input
                  value={testEventCode}
                  onChange={(e) => setTestEventCode(e.target.value)}
                  placeholder={t('testEventCodePlaceholder')}
                  disabled={!canEdit}
                />
                <Button type="button" variant="outline" onClick={handleSaveTestCode} disabled={!canEdit || savingCode}>
                  {savingCode ? <Loader2 className="size-4 animate-spin" /> : t('saveButton')}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('testEventCodeHint')}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="outline" onClick={handleTest} disabled={testing || !testEventCode.trim()}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {testing ? t('testing') : t('testButton')}
              </Button>
              {canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleUnlink}
                  disabled={unlinking}
                  className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                >
                  {unlinking ? <Loader2 className="size-4 animate-spin" /> : null}
                  {unlinking ? t('unlinking') : t('unlinkButton')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
