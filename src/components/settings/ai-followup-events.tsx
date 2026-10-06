'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format, parseISO } from 'date-fns';

interface FollowupEvent {
  id: string;
  kind: 'nudge' | 'close_no_reply';
  step: number | null;
  status: 'sent' | 'failed';
  error: string | null;
  message_text: string | null;
  created_at: string;
  conversation_id: string | null;
  contact_name: string | null;
  conversation_status: string | null;
  customer_replied: boolean;
}

type Filter = 'all' | 'sent' | 'failed' | 'replied' | 'silent';

/**
 * The Follow-up tab's history: every nudge the AI sent (or failed to send)
 * and every conversation it closed for silence, with the contact and
 * whether the customer wrote again. Admin-only, mirroring the API.
 */
export function AiFollowupEvents() {
  const t = useTranslations('Settings.aiFollowupEvents');
  const { accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;

  const [events, setEvents] = useState<FollowupEvent[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch('/api/ai/followup/events', { cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      const json = (await res.json()) as { events: FollowupEvent[] };
      setEvents(json.events);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    void load();
  }, [canView, load]);

  if (profileLoading || !canView) return null;

  const all = events ?? [];
  const sent = all.filter((e) => e.status === 'sent' && e.kind === 'nudge').length;
  const failed = all.filter((e) => e.status === 'failed').length;
  const replied = all.filter((e) => e.kind === 'nudge' && e.status === 'sent' && e.customer_replied).length;
  const closed = all.filter((e) => e.kind === 'close_no_reply').length;

  const visible = all.filter((e) => {
    if (filter === 'sent') return e.status === 'sent';
    if (filter === 'failed') return e.status === 'failed';
    if (filter === 'replied') return e.customer_replied;
    if (filter === 'silent') return e.status === 'sent' && !e.customer_replied && e.kind === 'nudge';
    return true;
  });

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: t('filterAll') },
    { key: 'sent', label: t('filterSent') },
    { key: 'failed', label: t('filterFailed') },
    { key: 'replied', label: t('filterReplied') },
    { key: 'silent', label: t('filterSilent') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('statSent')} value={sent} />
          <Stat label={t('statFailed')} value={failed} tone={failed > 0 ? 'bad' : undefined} />
          <Stat label={t('statReplied')} value={replied} tone="good" />
          <Stat label={t('statClosed')} value={closed} />
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === f.key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{t('loadFailed')}</p>}
        {!error && events === null && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
        {events !== null && visible.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>}

        {visible.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {visible.map((e) => (
              <li key={e.id} className="space-y-1 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{e.contact_name ?? t('unknownContact')}</span>
                  <span className="text-xs text-muted-foreground">{format(parseISO(e.created_at), 'dd/MM HH:mm')}</span>
                  <Badge variant="outline">
                    {e.kind === 'close_no_reply' ? t('kindClosed') : t('kindNudge', { step: e.step ?? 1 })}
                  </Badge>
                  {e.status === 'failed' ? (
                    <Badge variant="destructive">{t('statusFailed')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('statusSent')}</Badge>
                  )}
                  {e.kind === 'nudge' && e.status === 'sent' && (
                    <Badge variant={e.customer_replied ? 'secondary' : 'outline'}>
                      {e.customer_replied ? t('replied') : t('noReply')}
                    </Badge>
                  )}
                </div>
                {e.message_text && <p className="text-muted-foreground">{e.message_text}</p>}
                {e.error && <p className="text-xs text-destructive">{t('errorPrefix')} {e.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  const color = tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-emerald-600' : 'text-foreground';
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
