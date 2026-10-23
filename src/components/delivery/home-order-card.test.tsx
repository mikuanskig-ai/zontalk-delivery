import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DeliveryOrder } from '@/types'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { HomeOrderCard } from './home-order-card'

const baseOrder = (over: Partial<DeliveryOrder> = {}): DeliveryOrder =>
  ({
    id: 'fc80f287-7ee2-4fc8-9887-d8d1bc4f409d',
    status: 'confirmed',
    created_at: '2026-10-23T13:31:00Z',
    customer_name: 'Thais Griebeler',
    delivery_address: 'Rua marechal candido rondon 1596',
    payment_method: 'cartão no débito na entrega',
    payment_status: null,
    notes: 'troco para R$100',
    subtotal: 28,
    delivery_fee: 8,
    total: 36,
    currency: 'BRL',
    items: [
      { id: 'i1', product_name: 'Marmita P', quantity: 1, addons_snapshot: [{ option_name: 'Sem refogado' }], notes: null },
      { id: 'i2', product_name: 'Refrigerante Lata', quantity: 2, addons_snapshot: [], notes: null },
    ],
    ...over,
  }) as unknown as DeliveryOrder

const render = (props: Partial<React.ComponentProps<typeof HomeOrderCard>> = {}) =>
  renderToStaticMarkup(
    React.createElement(HomeOrderCard, {
      order: baseOrder(),
      stage: 'new',
      canEdit: true,
      busy: false,
      onMove: () => {},
      onPrint: () => {},
      onOpenDetails: () => {},
      ...props,
    }),
  )

describe('HomeOrderCard — what the kitchen needs without opening anything', () => {
  it('shows the short order number, customer, address, every item with its quantity, and the total', () => {
    const html = render()
    expect(html).toContain('#FC80F287')
    expect(html).toContain('Thais Griebeler')
    expect(html).toContain('Rua marechal candido rondon 1596')
    expect(html).toContain('Marmita P')
    expect(html).toContain('Refrigerante Lata')
    expect(html).toContain('2×')
    expect(html).toContain('36')
  })

  it('shows the add-ons chosen on an item', () => {
    expect(render()).toContain('Sem refogado')
  })

  it('shows how it is being paid and the order note (e.g. change to bring)', () => {
    const html = render()
    expect(html).toContain('cartão no débito na entrega')
    expect(html).toContain('troco para R$100')
  })

  it('labels an order with no address as pickup and one with an address as delivery', () => {
    expect(render({ order: baseOrder({ delivery_address: null }) })).toContain('>pickup<')
    expect(render()).toContain('>delivery<')
  })

  it('falls back to a generic label when the customer has no name', () => {
    expect(render({ order: baseOrder({ customer_name: null }) })).toContain('unknownCustomer')
  })
})

describe('HomeOrderCard — actions', () => {
  it('offers the next step for the order\'s current status, plus a shortcut to finish it', () => {
    const html = render({ order: baseOrder({ status: 'confirmed' }) })
    expect(html).toContain('action.confirmed')
    expect(html).toContain('>finish<')
  })

  it('on the last step (out for delivery) the main button already finishes it — no duplicate shortcut', () => {
    const html = render({ order: baseOrder({ status: 'out_for_delivery' }), stage: 'delivering' })
    expect(html).toContain('action.out_for_delivery')
    expect(html).not.toContain('>finish<')
  })

  it('a ready PICKUP order says it was picked up — not "out for delivery" — and has no finish shortcut (that button already finishes it)', () => {
    const html = render({ order: baseOrder({ status: 'ready', delivery_address: null }), stage: 'preparing' })
    expect(html).toContain('action.ready_pickup')
    expect(html).not.toContain('action.ready<')
    expect(html).not.toContain('>finish<')
  })

  it('a ready DELIVERY order still says it is going out for delivery', () => {
    const html = render({ order: baseOrder({ status: 'ready' }), stage: 'preparing' })
    expect(html).toContain('action.ready<')
    expect(html).not.toContain('action.ready_pickup')
  })

  it('offers no move buttons on a finished order, but print and details stay', () => {
    const html = render({ order: baseOrder({ status: 'delivered' }), stage: 'done' })
    expect(html).not.toContain('action.')
    expect(html).not.toContain('>finish<')
    expect(html).toContain('aria-label="print"')
    expect(html).toContain('aria-label="details"')
  })

  it('hides every move button from someone who cannot edit orders, but still lets them print and look', () => {
    const html = render({ canEdit: false })
    expect(html).not.toContain('action.')
    expect(html).not.toContain('>finish<')
    expect(html).toContain('aria-label="print"')
    expect(html).toContain('aria-label="details"')
  })
})
