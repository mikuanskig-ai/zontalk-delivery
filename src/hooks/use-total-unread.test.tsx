// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

// A stand-in for supabase-js's realtime registry with the one behavior
// that matters here: `channel(name)` returns the EXISTING channel for a
// name that is already in use, and adding a `postgres_changes` listener
// to a channel that was already subscribed throws — exactly what
// supabase-js does ("cannot add `postgres_changes` callbacks for
// realtime:<name> after `subscribe()`").
const h = vi.hoisted(() => ({
  names: [] as string[],
  registry: new Map<string, { subscribed: boolean }>(),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () =>
        Promise.resolve({
          data: [
            { id: 'c1', unread_count: 2 },
            { id: 'c2', unread_count: 0 },
            { id: 'c3', unread_count: 5 },
          ],
          error: null,
        }),
    }),
    channel: (name: string) => {
      h.names.push(name)
      let ch = h.registry.get(name)
      if (!ch) {
        ch = { subscribed: false }
        h.registry.set(name, ch)
      }
      const channel = {
        on: () => {
          if (ch!.subscribed) {
            throw new Error(`cannot add \`postgres_changes\` callbacks for realtime:${name} after \`subscribe()\`.`)
          }
          return channel
        },
        subscribe: () => {
          ch!.subscribed = true
          return channel
        },
        __name: name,
      }
      return channel
    },
    removeChannel: (channel: { __name: string }) => {
      h.registry.delete(channel.__name)
    },
  }),
}))

import { useTotalUnread } from './use-total-unread'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({ label }: { label: string }) {
  return React.createElement('span', { 'data-label': label }, String(useTotalUnread()))
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.names.length = 0
  h.registry.clear()
})

describe('useTotalUnread', () => {
  it('counts conversations with at least one unread message', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    await act(async () => {
      createRoot(el).render(React.createElement(Consumer, { label: 'a' }))
    })
    expect(el.querySelector('[data-label="a"]')!.textContent).toBe('2')
  })

  it('lets two components use it on the same screen — regression, 2026-10-23 (the sidebar already used it; the new home screen called it a second time, and the shared channel name made the second call throw, crashing the whole dashboard route)', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })

    await act(async () => {
      createRoot(el).render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Consumer, { label: 'sidebar' }),
          React.createElement(Consumer, { label: 'home' }),
        ),
      )
    })

    expect(errors).toEqual([])
    expect(el.querySelector('[data-label="sidebar"]')!.textContent).toBe('2')
    expect(el.querySelector('[data-label="home"]')!.textContent).toBe('2')
    // Each consumer needs a channel of its own.
    expect(new Set(h.names).size).toBe(2)
    spy.mockRestore()
  })
})
