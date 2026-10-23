import { describe, it, expect } from 'vitest'
import { buildNavGroups, pathMatchesItem } from './nav-config'

const hrefs = (groups: ReturnType<typeof buildNavGroups>) => groups.flatMap((g) => g.items.map((i) => i.href))

describe('buildNavGroups', () => {
  it('leaves accounts without Delivery exactly as before — same items, same order, nothing collapsible', () => {
    const groups = buildNavGroups(false)
    expect(groups.map((g) => g.items.map((i) => i.href))).toEqual([
      ['/dashboard', '/inbox', '/contacts', '/pipelines'],
      ['/broadcasts', '/automations', '/flows', '/agents'],
    ])
    expect(groups.some((g) => g.collapsible)).toBe(false)
  })

  it('puts the daily restaurant screens first for Delivery accounts: Início, Pedidos, Caixa de entrada, Cardápio', () => {
    const [primary] = buildNavGroups(true)
    expect(primary!.labelKey).toBeNull()
    expect(primary!.collapsible).toBeUndefined()
    expect(primary!.items.map((i) => i.href)).toEqual(['/dashboard', '/delivery', '/inbox', '/delivery/cardapio'])
    expect(primary!.items.map((i) => i.labelKey)).toEqual(['home', 'orders', 'inbox', 'cardapio'])
  })

  it('tucks the CRM tooling under one collapsible "Mais ferramentas" group', () => {
    const groups = buildNavGroups(true)
    expect(groups).toHaveLength(2)
    const more = groups[1]!
    expect(more.collapsible).toBe(true)
    expect(more.labelKey).toBe('moreTools')
    expect(more.items.map((i) => i.href)).toEqual(['/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents'])
  })

  it('removes no destination — every page the old layout reached is still in the Delivery layout', () => {
    const delivery = new Set(hrefs(buildNavGroups(true)))
    for (const href of hrefs(buildNavGroups(false))) expect(delivery.has(href)).toBe(true)
  })

  it('lists no destination twice', () => {
    const all = hrefs(buildNavGroups(true))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('pathMatchesItem', () => {
  it('matches the page itself and anything below it', () => {
    expect(pathMatchesItem('/contacts', '/contacts')).toBe(true)
    expect(pathMatchesItem('/contacts/abc-123', '/contacts')).toBe(true)
    expect(pathMatchesItem('/flows/9/runs', '/flows')).toBe(true)
  })

  it('does not match a different page that merely shares a prefix', () => {
    expect(pathMatchesItem('/contacts-export', '/contacts')).toBe(false)
    expect(pathMatchesItem('/automationsX', '/automations')).toBe(false)
  })
})
