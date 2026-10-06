import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn() }))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return { ...actual, requireRole: h.requireRole }
})

import { GET } from './route'

const EVENTS = [
  {
    id: 'e-2',
    kind: 'nudge',
    step: 1,
    status: 'sent',
    error: null,
    message_text: 'Oi Maria, ainda por aqui!',
    created_at: '2026-09-30T14:00:00Z',
    conversation_id: 'conv-A',
    contact_id: 'c-1',
    contacts: { name: 'Maria' },
    conversations: { status: 'pending' },
  },
  {
    id: 'e-1',
    kind: 'nudge',
    step: 1,
    status: 'sent',
    error: null,
    message_text: 'Oi João!',
    created_at: '2026-09-30T13:00:00Z',
    conversation_id: 'conv-B',
    contact_id: 'c-2',
    contacts: { name: 'João' },
    conversations: { status: 'closed' },
  },
  {
    id: 'e-0',
    kind: 'nudge',
    step: 1,
    status: 'failed',
    error: 'whatsapp down',
    message_text: 'Oi Ana!',
    created_at: '2026-09-30T12:00:00Z',
    conversation_id: 'conv-C',
    contact_id: null,
    contacts: null,
    conversations: null,
  },
]

// conv-B: customer wrote BEFORE the nudge (doesn't count) and AFTER (does count, for e-1 only).
const CUSTOMER_MSGS = [
  { conversation_id: 'conv-B', created_at: '2026-09-30T12:30:00Z' },
  { conversation_id: 'conv-B', created_at: '2026-09-30T13:30:00Z' },
]

function fakeSupabase() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: table === 'ai_followup_events' ? EVENTS : CUSTOMER_MSGS, error: null }),
        then: (res: (v: unknown) => void) => res({ data: table === 'messages' ? CUSTOMER_MSGS : EVENTS, error: null }),
      }
      return chain
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ supabase: fakeSupabase(), accountId: 'acc-1', userId: 'u-1' })
})

describe('GET /api/ai/followup/events', () => {
  it('lists events newest-first with the contact name and conversation status', async () => {
    const body = await (await GET()).json()
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(['e-2', 'e-1', 'e-0'])
    expect(body.events[0]).toMatchObject({ contact_name: 'Maria', conversation_status: 'pending', kind: 'nudge', status: 'sent' })
    expect(body.events[2]).toMatchObject({ status: 'failed', error: 'whatsapp down', contact_name: null })
  })

  it('reports a customer reply only when it came AFTER that specific event', async () => {
    const body = await (await GET()).json()
    const byId = Object.fromEntries(body.events.map((e: { id: string; customer_replied: boolean }) => [e.id, e.customer_replied]))
    expect(byId['e-1']).toBe(true) // reply at 13:30, nudge at 13:00
    expect(byId['e-2']).toBe(false) // no message from conv-A at all
    expect(byId['e-0']).toBe(false) // no conversation to reply in
  })

  it('refuses non-admins — the same gate as the rest of the AI settings writes', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account')
    h.requireRole.mockRejectedValue(new ForbiddenError('Admin only'))
    expect((await GET()).status).toBe(403)
  })
})
