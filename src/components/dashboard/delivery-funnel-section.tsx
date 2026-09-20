"use client"

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Info, Users, ShoppingBag, Repeat2, Heart, Receipt, Printer } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { hasModule } from '@/lib/accounts/modules'
import { formatCurrency } from '@/lib/currency'
import { loadDeliveryFunnel, loadDeliveryOrdersSummary } from '@/lib/dashboard/delivery-funnel'
import type { DeliveryFunnelData, DeliveryOrdersSummary } from '@/lib/dashboard/types'
import type { OrderDateRange } from '@/components/delivery/order-date-range-filter'
import { Button } from '@/components/ui/button'
import { MetricCard } from './metric-card'
import { SkeletonCard } from './skeleton'
import { EmptyState } from './empty-state'
import { FunnelStack } from './funnel-stack'

// "Todo o período" (range === null) resolves to this — treated as
// "since the account's creation" rather than blocked.
const EPOCH = new Date(0)

function pctLabel(part: number, base: number, suffix: string): string | undefined {
  if (base <= 0) return undefined
  return `${Math.round((part / base) * 100)}% ${suffix}`
}

/**
 * Delivery block of the dashboard, scoped to the period picked in the
 * page header: order/revenue summary (Pedidos, valor, faturado =
 * impressos) + the customer funnel (novos contatos → converteram →
 * recorrentes → fiéis). "Converteram" = clientes distintos com 1+
 * pedido NO período (bate com a aba Pedidos); recorrência é sempre
 * vitalícia — ver migration 082. Renders nothing while the profile is
 * loading or when the delivery module is off.
 */
export function DeliveryFunnelSection({ range }: { range: OrderDateRange | null }) {
  const t = useTranslations('Dashboard.deliveryFunnel')
  const tLoadError = useTranslations('Dashboard.loadError')
  const { account, accountId, profileLoading, defaultCurrency } = useAuth()
  const moduleEnabled = hasModule(account, 'delivery')

  const [data, setData] = useState<DeliveryFunnelData | null>(null)
  const [summary, setSummary] = useState<DeliveryOrdersSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    if (!accountId) return
    setLoading(true)
    setError(false)
    const db = createClient()
    const effective = range ?? { from: EPOCH, to: new Date() }
    void Promise.all([
      loadDeliveryFunnel(db, accountId, effective),
      loadDeliveryOrdersSummary(db, accountId, effective),
    ])
      .then(([funnel, orders]) => {
        setData(funnel)
        setSummary(orders)
      })
      .catch((err) => {
        console.error('[dashboard] delivery funnel failed:', err)
        setError(true)
      })
      .finally(() => setLoading(false))
  }, [accountId, range])

  useEffect(() => {
    if (profileLoading || !moduleEnabled || !accountId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside load()'s own .finally callback
    load()
  }, [profileLoading, moduleEnabled, accountId, load])

  if (profileLoading || !moduleEnabled) return null

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </div>

      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title={tLoadError('title')}
          hint={tLoadError('hint')}
          action={
            <Button size="sm" variant="outline" onClick={load}>
              {tLoadError('retry')}
            </Button>
          }
        />
      ) : loading || !data || !summary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title={t('ordersCount')}
              value={summary.ordersCount.toLocaleString()}
              icon={ShoppingBag}
            />
            <MetricCard
              title={t('ordersTotal')}
              value={formatCurrency(summary.ordersTotal, defaultCurrency)}
              icon={Receipt}
            />
            <MetricCard
              title={t('printedTotal')}
              value={formatCurrency(summary.printedTotal, defaultCurrency)}
              icon={Printer}
              subtitle={t('printedCount', { printed: summary.printedCount, total: summary.ordersCount })}
            />
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <FunnelStack
              stages={[
                { key: 'new', label: t('newContacts'), value: data.newContacts.toLocaleString(), icon: Users },
                {
                  key: 'ordering',
                  label: t('orderingCustomers'),
                  value: data.orderingCustomers.toLocaleString(),
                  icon: ShoppingBag,
                },
                {
                  key: 'returning',
                  label: t('returningCustomers'),
                  value: data.returningCustomers.toLocaleString(),
                  hint: pctLabel(data.returningCustomers, data.orderingCustomers, t('ofOrderingCustomers')),
                  icon: Repeat2,
                },
                {
                  key: 'loyal',
                  label: t('loyalCustomers'),
                  value: data.loyalCustomers.toLocaleString(),
                  hint: pctLabel(data.loyalCustomers, data.orderingCustomers, t('ofOrderingCustomers')),
                  icon: Heart,
                },
              ]}
            />
          </div>
          {data.unattributedOrders > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" aria-hidden />
              {t('unattributedOrders', { count: data.unattributedOrders })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
