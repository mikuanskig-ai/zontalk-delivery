// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const h = vi.hoisted(() => ({
  registry: new Map<string, { subscribed: boolean }>(),
  orderQuery: [] as [string, unknown[]][],
  orders: [] as unknown[],
  ordersError: null as unknown,
}))

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'pt' }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1', defaultCurrency: 'BRL', accountRole: 'owner', profileLoading: false }),
}))
vi.mock('@/hooks/use-can', () => ({ useCan: () => true }))
// OrderDetailSheet pulls in its own auth/permission wiring; it is closed on
// this screen until a card's "details" button is pressed.
vi.mock('./order-detail-sheet', () => ({ OrderDetailSheet: () => null }))

// Same supabase-js rule the real client enforces: a repeated channel name
// returns the already-subscribed channel, and adding a listener to it throws.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gte', 'not', 'order']) {
        chain[m] = (...args: unknown[]) => {
          if (table === 'delivery_orders') h.orderQuery.push([m, args])
          return chain
        }
      }
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(
          table === 'delivery_orders'
            ? { data: h.ordersError ? null : h.orders, error: h.ordersError }
            : { data: [{ id: 'c1', unread_count: 2 }, { id: 'c2', unread_count: 0 }], error: null },
        )
      return chain
    },
    channel: (name: string) => {
      let ch = h.registry.get(name)
      if (!ch) h.registry.set(name, (ch = { subscribed: false }))
      const channel = {
        __name: name,
        on: () => {
          if (ch!.subscribed) throw new Error(`cannot add \`postgres_changes\` callbacks for realtime:${name} after \`subscribe()\`.`)
          return channel
        },
        subscribe: () => ((ch!.subscribed = true), channel),
      }
      return channel
    },
    removeChannel: (c: { __name: string }) => void h.registry.delete(c.__name),
  }),
}))

import { TodayOrdersHome } from './today-orders-home'
import { useTotalUnread } from '@/hooks/use-total-unread'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Stands in for the sidebar, which also calls the hook on every dashboard screen. */
function SidebarStandIn() {
  return React.createElement('nav', { 'data-testid': 'sidebar' }, `unread:${useTotalUnread()}`)
}

const order = (id: string, status: string, name: string, total: number, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  created_at: new Date().toISOString(),
  customer_name: name,
  delivery_address: 'Rua A 10',
  payment_method: 'pix',
  payment_status: null,
  notes: null,
  total,
  currency: 'BRL',
  contact: null,
  items: [{ id: `${id}-i`, product_name: 'Marmita P', quantity: 1, addons_snapshot: [], notes: null }],
  ...extra,
})

async function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const errors: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
  await act(async () => {
    createRoot(el).render(
      React.createElement(React.Fragment, null, React.createElement(SidebarStandIn), React.createElement(TodayOrdersHome)),
    )
  })
  // Let the async load and the hook's own fetch settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return { el, errors, restore: () => spy.mockRestore() }
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.registry.clear()
  h.orderQuery.length = 0
  h.ordersError = null
  h.orders = [
    order('aaaaaaaa-1', 'confirmed', 'Thais', 36),
    order('bbbbbbbb-2', 'in_production', 'Alisson', 51),
    order('cccccccc-3', 'delivered', 'Ivonete', 75, { delivery_address: null }),
  ]
})

describe('TodayOrdersHome — mounted next to another user of the unread hook, like the real dashboard', () => {
  it('renders without crashing (regression, 2026-10-23: shipped a dashboard that threw on mount)', async () => {
    const { el, errors, restore } = await mount()
    expect(errors).toEqual([])
    expect(el.textContent).toContain('Thais')
    expect(el.textContent).toContain('Alisson')
    expect(el.textContent).toContain('Ivonete')
    restore()
  })

  it("shows the day's numbers and the shared unread count from the same hook the sidebar uses", async () => {
    const { el, restore } = await mount()
    expect(el.querySelector('[data-testid="sidebar"]')!.textContent).toBe('unread:1')
    // 3 live orders, R$162 total.
    expect(el.textContent).toContain('3')
    expect(el.textContent).toMatch(/162/)
    restore()
  })

  it("only asks for today's non-cancelled orders of this account", async () => {
    const { restore } = await mount()
    const q = Object.fromEntries(h.orderQuery.map(([m, a]) => [m, a]))
    expect(q.eq).toEqual(['account_id', 'acc-1'])
    expect(q.gte![0]).toBe('created_at')
    expect(q.not).toEqual(['status', 'in', '(cancelled,draft)'])
    restore()
  })

  it('shows the empty state when there are no orders today', async () => {
    h.orders = []
    const { el, restore } = await mount()
    expect(el.textContent).toContain('emptyTitle')
    restore()
  })

  it('offers a retry instead of a blank screen when the orders cannot be loaded', async () => {
    h.ordersError = { message: 'boom' }
    const { el, restore } = await mount()
    expect(el.textContent).toContain('loadFailed')
    expect(el.textContent).toContain('retry')
    restore()
  })
})
