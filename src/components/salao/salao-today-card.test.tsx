// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const h = vi.hoisted(() => ({
  open: { data: [] as { total: number | string }[] | null, error: null as unknown },
  closed: { data: [] as { total: number | string }[] | null, error: null as unknown },
  queries: [] as { table: string; calls: [string, unknown[]][] }[],
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1', defaultCurrency: 'BRL' }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q = { table, calls: [] as [string, unknown[]][] }
      h.queries.push(q)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte']) {
        chain[m] = (...args: unknown[]) => {
          q.calls.push([m, args])
          return chain
        }
      }
      // A query that asked for status = closed is the "sold today" one.
      chain.then = (resolve: (v: unknown) => void) => resolve(q.calls.some(([m, a]) => m === 'eq' && a[1] === 'closed') ? h.closed : h.open)
      return chain
    },
  }),
}))

import { SalaoTodayCard } from './salao-today-card'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const errors: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
  await act(async () => {
    createRoot(el).render(React.createElement(SalaoTodayCard))
  })
  return { el, errors, restore: () => spy.mockRestore() }
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.queries.length = 0
  h.open = { data: [{ total: 110 }, { total: '62.10' }], error: null }
  h.closed = { data: [{ total: 200 }, { total: 50.5 }, { total: 10 }], error: null }
})

describe('SalaoTodayCard', () => {
  it('shows the open tabs and what was sold today, with cents', async () => {
    const { el, errors, restore } = await mount()
    expect(errors).toEqual([])
    const text = el.textContent!.replace(/\s/g, ' ')
    expect(text).toContain('Salão hoje')
    expect(el.querySelector('a')!.getAttribute('href')).toBe('/salao')
    // 2 open tabs worth 172,10; 3 closed worth 260,50
    expect(text).toMatch(/Comandas abertas ?2/)
    expect(text).toContain('R$ 172,10')
    expect(text).toMatch(/Comandas fechadas hoje ?3/)
    expect(text).toContain('R$ 260,50')
    restore()
  })

  it('asks only for this account\'s tabs, open ones and the ones closed since the start of today', async () => {
    const { restore } = await mount()
    const tabs = h.queries.filter((q) => q.table === 'salao_tabs')
    expect(tabs).toHaveLength(2)
    for (const q of tabs) expect(q.calls).toContainEqual(['eq', ['account_id', 'acc-1']])
    const closed = tabs.find((q) => q.calls.some(([m, a]) => m === 'eq' && a[1] === 'closed'))!
    expect(closed.calls.some(([m, a]) => m === 'gte' && a[0] === 'closed_at')).toBe(true)
    restore()
  })

  it('renders nothing (and does not crash the home screen) when the query fails', async () => {
    h.open = { data: null, error: { message: 'boom' } }
    const { el, errors, restore } = await mount()
    expect(errors).toEqual([])
    expect(el.textContent).toBe('')
    restore()
  })

  it('an empty day shows zeros, not a blank card', async () => {
    h.open = { data: [], error: null }
    h.closed = { data: [], error: null }
    const { el, restore } = await mount()
    const text = el.textContent!.replace(/\s/g, ' ')
    expect(text).toMatch(/Comandas abertas ?0/)
    expect(text).toContain('R$ 0,00')
    restore()
  })
})
