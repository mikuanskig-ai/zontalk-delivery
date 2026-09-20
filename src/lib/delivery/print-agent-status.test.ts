import { describe, expect, it } from 'vitest'
import { AGENT_ONLINE_WINDOW_MS, computePrintAgentStatus } from './print-agent-status'

const NOW = new Date('2026-09-20T15:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('computePrintAgentStatus', () => {
  it('is online when the last poll is inside the window', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: ago(30_000), pendingCount: 5, now: NOW })
    expect(s).toMatchObject({ online: true, needsAttention: false, offlineForMs: 30_000 })
  })

  it('tolerates a short gap (restart / wifi blip) without alerting', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: ago(AGENT_ONLINE_WINDOW_MS - 1), pendingCount: 3, now: NOW })
    expect(s.needsAttention).toBe(false)
  })

  it('needs attention: offline past the window WITH pending orders', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: ago(201 * 60_000), pendingCount: 11, now: NOW })
    expect(s).toMatchObject({ online: false, needsAttention: true, pendingCount: 11 })
  })

  it('does not alert when offline but nothing is waiting (shop closed overnight)', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: ago(10 * 3600_000), pendingCount: 0, now: NOW })
    expect(s).toMatchObject({ online: false, needsAttention: false })
  })

  it('treats "never polled" as offline, and alerts if orders are waiting', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: null, pendingCount: 2, now: NOW })
    expect(s).toMatchObject({ online: false, offlineForMs: null, needsAttention: true })
  })

  it('never alerts when auto-print is off', () => {
    const s = computePrintAgentStatus({ enabled: false, lastPolledAt: null, pendingCount: 9, now: NOW })
    expect(s.needsAttention).toBe(false)
  })

  it('clamps a clock-skewed future poll to 0 instead of going negative', () => {
    const s = computePrintAgentStatus({ enabled: true, lastPolledAt: new Date(NOW + 5000).toISOString(), pendingCount: 1, now: NOW })
    expect(s.offlineForMs).toBe(0)
    expect(s.online).toBe(true)
  })
})
