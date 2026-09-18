import { describe, it, expect } from 'vitest'
import { parseWuzapiEvent, type WuzapiWebhookPayload } from './route'

function textPayload(overrides: {
  text?: string
  contextInfo?: { externalAdReply?: { ctwaClid?: string } }
} = {}): WuzapiWebhookPayload {
  return {
    userID: 'u1',
    type: 'Message',
    event: {
      Info: {
        Chat: '5545999998888@s.whatsapp.net',
        SenderAlt: '5545999998888@s.whatsapp.net',
        ID: 'wamid-1',
        Timestamp: '2026-09-18T10:00:00-03:00',
        PushName: 'Cliente',
        IsFromMe: false,
        IsGroup: false,
      },
      Message: {
        extendedTextMessage: { text: overrides.text ?? 'Oi', contextInfo: overrides.contextInfo },
      },
    },
  }
}

describe('parseWuzapiEvent — Meta CAPI CTWA attribution (2026-09-18)', () => {
  it('extracts ctwa_clid from extendedTextMessage.contextInfo.externalAdReply when present', async () => {
    const payload = textPayload({ contextInfo: { externalAdReply: { ctwaClid: 'AbCdEf123' } } })
    const parsed = await parseWuzapiEvent(payload)
    expect(parsed?.ctwaClid).toBe('AbCdEf123')
  })

  it('is null when there is no contextInfo at all — the overwhelming majority of messages', async () => {
    const payload = textPayload()
    const parsed = await parseWuzapiEvent(payload)
    expect(parsed?.ctwaClid).toBeNull()
  })

  it('is null when contextInfo is present but has no externalAdReply (e.g. a reply-to-message context)', async () => {
    const payload = textPayload({ contextInfo: {} })
    const parsed = await parseWuzapiEvent(payload)
    expect(parsed?.ctwaClid).toBeNull()
  })

  it('extracts it from imageMessage.contextInfo too — a customer can land from an ad and send a photo first', async () => {
    const payload: WuzapiWebhookPayload = {
      userID: 'u1',
      type: 'Message',
      event: {
        Info: {
          Chat: '5545999998888@s.whatsapp.net',
          SenderAlt: '5545999998888@s.whatsapp.net',
          ID: 'wamid-2',
          Timestamp: '2026-09-18T10:00:00-03:00',
          IsFromMe: false,
          IsGroup: false,
        },
        Message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            contextInfo: { externalAdReply: { ctwaClid: 'clid-from-image' } },
          },
        },
      },
    }
    const parsed = await parseWuzapiEvent(payload)
    expect(parsed?.ctwaClid).toBe('clid-from-image')
  })

  it('still parses the message content correctly alongside the attribution', async () => {
    const payload = textPayload({ text: 'Quero pedir uma marmita', contextInfo: { externalAdReply: { ctwaClid: 'clid-1' } } })
    const parsed = await parseWuzapiEvent(payload)
    expect(parsed?.content.contentText).toBe('Quero pedir uma marmita')
    expect(parsed?.ctwaClid).toBe('clid-1')
  })
})
