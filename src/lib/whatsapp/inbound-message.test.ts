import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ updateCalls: [] as { payload: unknown; eqArgs: [string, unknown][] }[], error: null as unknown }))

// `supabaseAdmin()` is a local lazy-singleton inside inbound-message.ts
// itself (not a separate module) that calls `createClient` from
// `@supabase/supabase-js` — mocked at that source instead.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const call: { payload: unknown; eqArgs: [string, unknown][] } = { payload: null, eqArgs: [] }
      const chain = {
        update: (payload: unknown) => {
          call.payload = payload
          return chain
        },
        eq: (col: string, val: unknown) => {
          call.eqArgs.push([col, val])
          return chain
        },
        is: (col: string, val: unknown) => {
          call.eqArgs.push([col, val])
          h.updateCalls.push(call)
          return Promise.resolve({ error: h.error })
        },
      }
      return chain
    },
  }),
}))

import { isValidStatusTransition, shouldDispatchAiReply, captureCtwaAttribution, reopenPatch } from './inbound-message'

describe('isValidStatusTransition', () => {
  it('allows forward moves along the ladder', () => {
    expect(isValidStatusTransition('pending', 'sent')).toBe(true)
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
  })

  it('refuses a backward move', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
  })

  it('accepts failed only from pending/sent, and treats it as terminal', () => {
    expect(isValidStatusTransition('pending', 'failed')).toBe(true)
    expect(isValidStatusTransition('sent', 'failed')).toBe(true)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
    expect(isValidStatusTransition('failed', 'sent')).toBe(false)
  })
})

describe('shouldDispatchAiReply', () => {
  const base = { flowConsumed: false, interactiveReplyId: null, inboundText: 'oi', contentType: 'text' }

  it('dispatches for an ordinary text message', () => {
    expect(shouldDispatchAiReply(base)).toBe(true)
  })

  it('dispatches for location and (transcribed) audio — the model can see both', () => {
    expect(shouldDispatchAiReply({ ...base, contentType: 'location' })).toBe(true)
    expect(shouldDispatchAiReply({ ...base, contentType: 'audio' })).toBe(true)
  })

  it('refuses a document even though its filename gives it non-blank text — regression, 2026-09-04 (Concórdia, Alzira Y. de Oliveira: a payment-receipt PDF triggered a dispatch the model could not actually see, and it cancelled + recreated a valid order)', () => {
    expect(
      shouldDispatchAiReply({ ...base, contentType: 'document', inboundText: 'comprovante.pdf' }),
    ).toBe(false)
  })

  it('refuses image/video/template/interactive the same way', () => {
    for (const contentType of ['image', 'video', 'template', 'interactive']) {
      expect(shouldDispatchAiReply({ ...base, contentType })).toBe(false)
    }
  })

  it('refuses when a flow already consumed the message', () => {
    expect(shouldDispatchAiReply({ ...base, flowConsumed: true })).toBe(false)
  })

  it('refuses an interactive button/list reply', () => {
    expect(shouldDispatchAiReply({ ...base, interactiveReplyId: 'reply-1' })).toBe(false)
  })

  it('refuses blank/whitespace-only text', () => {
    expect(shouldDispatchAiReply({ ...base, inboundText: '   ' })).toBe(false)
  })
})

describe('captureCtwaAttribution — Meta CAPI (2026-09-18)', () => {
  beforeEach(() => {
    h.updateCalls = []
    h.error = null
  })

  it('writes ad_attribution scoped to both contact_id and account_id, only when currently null', async () => {
    await captureCtwaAttribution('acct-1', 'contact-1', 'clid-123')

    expect(h.updateCalls).toHaveLength(1)
    const call = h.updateCalls[0]
    expect(call.payload).toMatchObject({ ad_attribution: expect.objectContaining({ ctwa_clid: 'clid-123' }) })
    expect(call.eqArgs).toEqual([
      ['id', 'contact-1'],
      ['account_id', 'acct-1'],
      ['ad_attribution', null],
    ])
  })

  it('never throws when the write fails — must never break inbound message ingestion', async () => {
    h.error = { message: 'boom' }
    await expect(captureCtwaAttribution('acct-1', 'contact-1', 'clid-123')).resolves.toBeUndefined()
  })
})

describe('reopenPatch — closed ticket resurfacing (2026-09-21)', () => {
  const NOW = '2026-09-21T15:00:00.000Z'

  it('with AI auto-reply on, hands the thread back to the bot (unassign, unpause, fresh reply budget)', () => {
    expect(reopenPatch(true, NOW)).toEqual({
      status: 'pending',
      closed_at: null,
      closed_by: null,
      close_reason: null,
      updated_at: NOW,
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_handoff_summary: null,
    })
  })

  it('with the AI off, only reopens — the previous handler stays assigned', () => {
    const patch = reopenPatch(false, NOW)
    expect(patch).toEqual({ status: 'pending', closed_at: null, closed_by: null, close_reason: null, updated_at: NOW })
    expect(patch).not.toHaveProperty('assigned_agent_id')
    expect(patch).not.toHaveProperty('ai_autoreply_disabled')
  })
})
