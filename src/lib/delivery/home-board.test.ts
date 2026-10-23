import { describe, it, expect } from 'vitest'
import type { DeliveryOrder, DeliveryOrderStatus } from '@/types'
import { groupByStage, isPickupOrder, nextStatus, nextStatusForOrder, stageOf, summarizeDay } from './home-board'

const order = (id: string, status: DeliveryOrderStatus, total: number, createdAt: string): DeliveryOrder =>
  ({ id, status, total, created_at: createdAt }) as DeliveryOrder

describe('stageOf', () => {
  it.each([
    ['pending_confirmation', 'new'],
    ['confirmed', 'new'],
    ['in_production', 'preparing'],
    ['ready', 'preparing'],
    ['out_for_delivery', 'delivering'],
    ['delivered', 'done'],
  ] as const)('%s → %s', (status, stage) => {
    expect(stageOf(status)).toBe(stage)
  })

  it('keeps drafts and cancelled orders off the board', () => {
    expect(stageOf('draft')).toBeNull()
    expect(stageOf('cancelled')).toBeNull()
  })
})

describe('nextStatus', () => {
  it('walks the real ladder one rung at a time', () => {
    expect(nextStatus('pending_confirmation')).toBe('confirmed')
    expect(nextStatus('confirmed')).toBe('in_production')
    expect(nextStatus('in_production')).toBe('ready')
    expect(nextStatus('ready')).toBe('out_for_delivery')
    expect(nextStatus('out_for_delivery')).toBe('delivered')
  })

  it('has no next step once delivered, or for statuses outside the ladder', () => {
    expect(nextStatus('delivered')).toBeNull()
    expect(nextStatus('cancelled')).toBeNull()
    expect(nextStatus('draft')).toBeNull()
  })
})

describe('nextStatusForOrder — pickup orders skip "out for delivery"', () => {
  it('treats an order with no delivery address as pickup', () => {
    expect(isPickupOrder({ delivery_address: null })).toBe(true)
    expect(isPickupOrder({ delivery_address: '' })).toBe(true)
    expect(isPickupOrder({ delivery_address: 'Rua A 1' })).toBe(false)
  })

  it('a ready pickup order is handed over, which closes it — it never goes out for delivery', () => {
    expect(nextStatusForOrder({ status: 'ready', delivery_address: null })).toBe('delivered')
  })

  it('a ready delivery order goes out for delivery, as usual', () => {
    expect(nextStatusForOrder({ status: 'ready', delivery_address: 'Rua A 1' })).toBe('out_for_delivery')
  })

  it('earlier steps are the same for pickup and delivery', () => {
    expect(nextStatusForOrder({ status: 'confirmed', delivery_address: null })).toBe('in_production')
    expect(nextStatusForOrder({ status: 'in_production', delivery_address: null })).toBe('ready')
  })

  it('has no next step once delivered', () => {
    expect(nextStatusForOrder({ status: 'delivered', delivery_address: null })).toBeNull()
  })
})

describe('groupByStage', () => {
  const orders = [
    order('late', 'confirmed', 30, '2026-10-23T12:30:00Z'),
    order('early', 'confirmed', 20, '2026-10-23T11:00:00Z'),
    order('cooking', 'in_production', 25, '2026-10-23T11:10:00Z'),
    order('out', 'out_for_delivery', 40, '2026-10-23T11:05:00Z'),
    order('done-old', 'delivered', 10, '2026-10-23T10:00:00Z'),
    order('done-new', 'delivered', 15, '2026-10-23T12:00:00Z'),
    order('gone', 'cancelled', 99, '2026-10-23T11:30:00Z'),
    order('draft', 'draft', 99, '2026-10-23T11:31:00Z'),
  ]

  it('puts every order in its column and drops cancelled/draft ones', () => {
    const g = groupByStage(orders)
    expect(g.new.map((o) => o.id)).toEqual(['early', 'late'])
    expect(g.preparing.map((o) => o.id)).toEqual(['cooking'])
    expect(g.delivering.map((o) => o.id)).toEqual(['out'])
    expect(g.done.map((o) => o.id)).toEqual(['done-new', 'done-old'])
  })

  it('puts the order that has waited longest on top of the work columns, newest on top of the done column', () => {
    const g = groupByStage(orders)
    expect(g.new[0]!.id).toBe('early')
    expect(g.done[0]!.id).toBe('done-new')
  })

  it('returns four empty columns for no orders', () => {
    expect(groupByStage([])).toEqual({ new: [], preparing: [], delivering: [], done: [] })
  })
})

describe('summarizeDay', () => {
  it('counts and sums only live orders — a cancelled order is not revenue', () => {
    const s = summarizeDay([
      order('a', 'confirmed', 28, 'x'),
      order('b', 'delivered', 36, 'x'),
      order('c', 'cancelled', 500, 'x'),
      order('d', 'draft', 500, 'x'),
    ])
    expect(s).toEqual({ count: 2, revenue: 64, averageTicket: 32 })
  })

  it('is all zeros for an empty day (no divide-by-zero)', () => {
    expect(summarizeDay([])).toEqual({ count: 0, revenue: 0, averageTicket: 0 })
  })
})
