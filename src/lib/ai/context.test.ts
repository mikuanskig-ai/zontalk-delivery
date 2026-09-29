import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AI_VISIBLE_CONTENT_TYPES, buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('AI_VISIBLE_CONTENT_TYPES', () => {
  it('is exactly the set of content types this file surfaces to the model — regression, 2026-09-04 (a document\'s non-blank filename let it slip past the webhook\'s dispatch gate even though it never showed up here; both checks must share this one set)', () => {
    expect([...AI_VISIBLE_CONTENT_TYPES].sort()).toEqual(['audio', 'location', 'text'])
  })
})

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third', content_type: 'text', created_at: '2026-09-29T10:02:00Z' },
      { sender_type: 'agent', content_text: 'second', content_type: 'text', created_at: '2026-09-29T10:01:00Z' },
      { sender_type: 'customer', content_text: 'first', content_type: 'text', created_at: '2026-09-29T10:00:00Z' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content:
          '[A human staff member wrote this to the customer directly — not you. Do not treat it as something you already said or did.] second',
      },
      { role: 'user', content: 'third' },
    ])
  })

  it('tags a human agent message so the model does not mistake it for its own prior turn — regression, 2026-08-17 (Concórdia: a staff voice note about an unrelated order got read back as the bot\'s own words, and it hallucinated an order confirmation without ever calling add_to_cart / place_order)', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'agent', content_text: 'Vou tirar aqui o teu pedido.', content_type: 'audio', created_at: '2026-09-29T10:00:01Z' }]),
      'conv-1',
    )
    expect(out).toEqual([
      {
        role: 'assistant',
        content:
          '[A human staff member wrote this to the customer directly — not you. Do not treat it as something you already said or did.] Vou tirar aqui o teu pedido.',
      },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply', content_type: 'text', created_at: '2026-09-29T10:00:02Z' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ', content_type: 'text', created_at: '2026-09-29T10:00:03Z' },
        { sender_type: 'customer', content_text: null, content_type: 'text', created_at: '2026-09-29T10:00:04Z' },
        { sender_type: 'customer', content_text: 'real', content_type: 'text', created_at: '2026-09-29T10:00:05Z' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes a location share, reformatted so the model recognizes it as coordinates to act on — regression, 2026-08-07', async () => {
    // Live incident: a customer dropped a WhatsApp location pin, but
    // location messages were excluded from context entirely — the
    // model had no idea one had been sent and just asked for a typed
    // address instead.
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_text: '-24.9532935,-53.4699534',
          content_type: 'location',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[Customer shared their location] latitude=-24.9532935, longitude=-53.4699534' },
    ])
  })

  it('falls back to the raw text when a location message does not parse as coordinates', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'Minha Padaria', content_type: 'location', created_at: '2026-09-29T10:00:06Z' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: '[Customer shared their location] Minha Padaria' }])
  })

  it('includes a transcribed voice note (content_text filled in by the webhook) as a normal user message', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'quero uma marmita grande', content_type: 'audio', created_at: '2026-09-29T10:00:07Z' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'quero uma marmita grande' }])
  })

  it('drops an untranscribed voice note (content_text still null) same as any other media', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: null, content_type: 'audio', created_at: '2026-09-29T10:00:08Z' },
        { sender_type: 'customer', content_text: 'depois disso', content_type: 'text', created_at: '2026-09-29T10:00:09Z' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'depois disso' }])
  })

  describe('session-gap note — regression, 2026-09-29 (Concórdia: a customer\'s plain "bom dia" landed right after a human agent\'s terse, unrelated order from 8 days earlier still sitting in the last-N window — with no timestamps at all, the model could not tell the two apart and "continued" the stale order: same items, same address, same payment method, none of it mentioned this time)', () => {
    it('inserts a note when the gap between two messages is 6h or more', async () => {
      const out = await buildConversationContext(
        fakeDb([
          // Newest-first, matching the real query — the fn reverses it.
          { sender_type: 'customer', content_text: 'bom dia', content_type: 'text', created_at: '2026-09-29T12:12:31Z' },
          { sender_type: 'customer', content_text: 'pedido antigo', content_type: 'text', created_at: '2026-09-21T14:00:00Z' },
        ]),
        'conv-1',
      )
      expect(out).toEqual([
        { role: 'user', content: 'pedido antigo' },
        {
          role: 'user',
          content:
            '[Nota do sistema: passaram-se 8 dias desde a mensagem anterior. Tudo antes desta linha é de um atendimento JÁ ENCERRADO — não assuma que algum item, endereço ou pedido citado ali ainda vale. Se o cliente quiser algo, ele vai dizer de novo agora.]',
        },
        { role: 'user', content: 'bom dia' },
      ])
    })

    it('does not insert a note for a normal same-conversation gap under 6h', async () => {
      const out = await buildConversationContext(
        fakeDb([
          { sender_type: 'bot', content_text: 'oi, tudo bem?', content_type: 'text', created_at: '2026-09-29T15:59:59Z' },
          { sender_type: 'customer', content_text: 'oi', content_type: 'text', created_at: '2026-09-29T10:00:00Z' },
        ]),
        'conv-1',
      )
      expect(out).toEqual([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'oi, tudo bem?' },
      ])
    })

    it('inserts one note per gap when a conversation has several stale periods', async () => {
      const out = await buildConversationContext(
        fakeDb([
          { sender_type: 'customer', content_text: 'C', content_type: 'text', created_at: '2026-09-10T10:00:01Z' },
          { sender_type: 'customer', content_text: 'B', content_type: 'text', created_at: '2026-09-10T10:00:00Z' },
          { sender_type: 'customer', content_text: 'A', content_type: 'text', created_at: '2026-09-01T10:00:00Z' },
        ]),
        'conv-1',
      )
      expect(out.map((m) => m.content)).toEqual([
        'A',
        expect.stringContaining('Nota do sistema'),
        'B',
        'C',
      ])
    })
  })
})
