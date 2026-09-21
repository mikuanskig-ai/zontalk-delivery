'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageCircleReply } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { hasModule } from '@/lib/accounts/modules';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * "Follow-up e encerramento" — migration 084. Lives under Agentes de IA
 * → Configuração because it is part of how the AI behaves: nudging a
 * customer who left an order half-done, and sending finished chats to
 * Fechados on its own. Everything is opt-in.
 */
export function AiFollowupConfig() {
  const { account, accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiFollowup');
  const moduleEnabled = hasModule(account, 'delivery');

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [delay, setDelay] = useState('20');
  const [max, setMax] = useState('1');
  const [messages, setMessages] = useState<string[]>(['', '', '']);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [closeMinutes, setCloseMinutes] = useState('120');
  const [autoCloseOn, setAutoCloseOn] = useState(false);
  const [autoCloseMinutes, setAutoCloseMinutes] = useState('20');

  const loadedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/followup', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setDefaults(data.default_messages ?? []);
      setConfigured(!!data.configured);
      if (data.configured) {
        setEnabled(!!data.followup_enabled);
        setDelay(String(data.followup_delay_minutes));
        setMax(String(data.followup_max));
        const typed: string[] = Array.isArray(data.followup_messages) ? data.followup_messages : [];
        setMessages([typed[0] ?? '', typed[1] ?? '', typed[2] ?? '']);
        setCloseMinutes(String(data.followup_close_minutes));
        setAutoCloseOn(data.auto_close_after_order_minutes != null);
        setAutoCloseMinutes(String(data.auto_close_after_order_minutes ?? 20));
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedFor.current === accountId) return;
    loadedFor.current = accountId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, state is set once the fetch settles
    void load();
  }, [accountId, load]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          followup_enabled: enabled,
          followup_delay_minutes: Number(delay),
          followup_max: Number(max),
          followup_messages: messages,
          followup_close_minutes: Number(closeMinutes),
          auto_close_after_order_minutes: autoCloseOn ? Number(autoCloseMinutes) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (profileLoading || !moduleEnabled) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  const nudgeCount = Math.min(3, Math.max(1, Number(max) || 1));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground text-base">
          <MessageCircleReply className="size-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!configured && <p className="text-sm text-muted-foreground">{t('needsAi')}</p>}

        <section className="space-y-4">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('followupToggle')}</p>
              <p className="text-xs text-muted-foreground">{t('followupToggleDesc')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit || !configured} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('delayLabel')}</p>
              <Input type="number" min={5} max={720} value={delay} onChange={(e) => setDelay(e.target.value)} disabled={!canEdit || !configured} />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('maxLabel')}</p>
              <Input type="number" min={1} max={3} value={max} onChange={(e) => setMax(e.target.value)} disabled={!canEdit || !configured} />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('closeLabel')}</p>
              <Input type="number" min={0} max={1440} value={closeMinutes} onChange={(e) => setCloseMinutes(e.target.value)} disabled={!canEdit || !configured} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('timingHint')}</p>

          <div className="space-y-3">
            {Array.from({ length: nudgeCount }).map((_, i) => (
              <div key={i}>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('messageLabel', { n: i + 1 })}</p>
                <Textarea
                  rows={3}
                  maxLength={600}
                  value={messages[i]}
                  placeholder={defaults[i] ?? ''}
                  onChange={(e) => setMessages((prev) => prev.map((m, j) => (j === i ? e.target.value : m)))}
                  disabled={!canEdit || !configured}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{t('variablesHint')}</p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('autoCloseToggle')}</p>
              <p className="text-xs text-muted-foreground">{t('autoCloseToggleDesc')}</p>
            </div>
            <Switch checked={autoCloseOn} onCheckedChange={setAutoCloseOn} disabled={!canEdit || !configured} />
          </div>
          {autoCloseOn && (
            <div className="max-w-xs">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('autoCloseLabel')}</p>
              <Input type="number" min={1} max={720} value={autoCloseMinutes} onChange={(e) => setAutoCloseMinutes(e.target.value)} disabled={!canEdit || !configured} />
            </div>
          )}
        </section>

        {canEdit && (
          <Button type="button" onClick={handleSave} disabled={saving || !configured}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saving ? t('saving') : t('save')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
