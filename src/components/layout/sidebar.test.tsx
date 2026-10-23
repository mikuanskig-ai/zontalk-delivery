import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const h = vi.hoisted(() => ({
  pathname: '/dashboard',
  modules: [] as string[],
}))

vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/hooks/use-total-unread', () => ({ useTotalUnread: () => 0 }))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    profile: { full_name: 'Sil', email: 'sil@concordia.com', avatar_url: null, is_platform_admin: false },
    profileLoading: false,
    accountRole: 'owner',
    account: { id: 'a1', name: 'Concórdia', enabled_modules: h.modules, default_currency: 'BRL', status: 'active' },
  }),
}))

import { Sidebar } from './sidebar'

const render = () => renderToStaticMarkup(React.createElement(Sidebar))
const order = (html: string, keys: string[]) => keys.map((k) => html.indexOf(`>${k}<`))

beforeEach(() => {
  h.pathname = '/dashboard'
})

describe('Sidebar — account with the Delivery module', () => {
  beforeEach(() => {
    h.modules = ['delivery']
  })

  it('shows the daily screens first, in order: Pedidos, Caixa de entrada, Cardápio, Painel', () => {
    const idx = order(render(), ['orders', 'inbox', 'cardapio', 'dashboard'])
    expect(idx.every((i) => i > -1)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('starts with "Mais ferramentas" collapsed — the CRM tools are not in the menu until opened', () => {
    const html = render()
    expect(html).toContain('moreTools')
    expect(html).toMatch(/aria-expanded="false"/)
    for (const href of ['/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents']) {
      expect(html).not.toContain(`href="${href}"`)
    }
  })

  it('keeps Configurações reachable at the bottom', () => {
    expect(render()).toContain('href="/settings"')
  })
})

describe('Sidebar — account without the Delivery module', () => {
  beforeEach(() => {
    h.modules = []
  })

  it('is unchanged: every CRM item is in the menu and there is no "Mais ferramentas"', () => {
    const html = render()
    for (const href of ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents']) {
      expect(html).toContain(`href="${href}"`)
    }
    expect(html).not.toContain('moreTools')
    expect(html).not.toContain('href="/delivery"')
  })
})
