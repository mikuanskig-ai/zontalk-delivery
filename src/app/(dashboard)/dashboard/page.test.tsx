// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const h = vi.hoisted(() => ({
  auth: { account: null as unknown, profileLoading: false, defaultCurrency: 'BRL' },
}))

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'pt' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/components/delivery/today-orders-home', () => ({
  TodayOrdersHome: () => React.createElement('div', { 'data-testid': 'home' }, 'HOME'),
}))

// The CRM dashboard (the "Resultados" tab / non-Delivery accounts) loads a
// lot of data; keeping every load pending leaves it in its loading state,
// which is enough to prove it mounts without crashing.
vi.mock('@/lib/dashboard/queries', () => {
  const pending = () => new Promise<never>(() => {})
  return {
    loadActivity: pending,
    loadConversationsSeries: pending,
    loadMetrics: pending,
    loadPipelineDonut: pending,
    loadResponseTime: pending,
  }
})
vi.mock('@/lib/supabase/client', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'not', 'in', 'limit']) chain[m] = () => chain
  chain.then = () => {}
  return { createClient: () => ({ from: () => chain, rpc: () => chain, channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: () => {} }) }
})

import DashboardPage from './page'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const withModules = (enabled_modules: string[]) => ({ id: 'a1', name: 'X', enabled_modules, default_currency: 'BRL', status: 'active' })

async function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const errors: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
  await act(async () => {
    createRoot(el).render(React.createElement(DashboardPage))
  })
  return { el, errors, restore: () => spy.mockRestore() }
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.auth = { account: null, profileLoading: false, defaultCurrency: 'BRL' }
})

describe('DashboardPage', () => {
  it("opens a Delivery account on today's orders, with the CRM numbers one tab over", async () => {
    h.auth.account = withModules(['delivery'])
    const { el, errors, restore } = await mount()
    expect(errors).toEqual([])
    expect(el.querySelector('[data-testid="home"]')).not.toBeNull()
    expect(el.textContent).toContain('tabToday')
    expect(el.textContent).toContain('tabResults')
    restore()
  })

  it('switches to the original CRM dashboard on the Resultados tab, without crashing', async () => {
    h.auth.account = withModules(['delivery'])
    const { el, errors, restore } = await mount()
    const results = [...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'tabResults') as HTMLElement
    await act(async () => {
      results.click()
    })
    expect(errors).toEqual([])
    expect(el.querySelector('[data-testid="home"]')).toBeNull()
    restore()
  })

  it('leaves an account without Delivery on the original dashboard — no tabs, no orders screen', async () => {
    h.auth.account = withModules([])
    const { el, errors, restore } = await mount()
    expect(errors).toEqual([])
    expect(el.querySelector('[data-testid="home"]')).toBeNull()
    expect(el.textContent).not.toContain('tabToday')
    restore()
  })

  it('shows only a placeholder while the profile is loading, so a restaurant never sees the CRM dashboard flash', async () => {
    h.auth.profileLoading = true
    const { el, restore } = await mount()
    expect(el.querySelector('[data-testid="home"]')).toBeNull()
    expect(el.textContent).toBe('')
    restore()
  })
})
