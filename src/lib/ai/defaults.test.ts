import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — today line', () => {
  // Confirmed live 2026-08-11: the model had no way to know what day
  // "today" is when answering from the knowledge base (as opposed to a
  // tool call, which resolves day-of-week pricing server-side) — see
  // defaults.ts's doc comment. These lock in the injected date line.

  it('states the correct weekday and ISO date for the given timezone', () => {
    // 2026-08-16 is a Sunday.
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T15:00:00Z'), // 12:00 in São Paulo (UTC-3), still Sunday there
    })
    expect(prompt).toContain('Today is Sunday, 2026-08-16')
  })

  it('uses the given timezone, not UTC, when they disagree on the date', () => {
    // 2026-08-16T01:00:00Z is Aug 15 22:00 in São Paulo (UTC-3) — still Saturday there.
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-16T01:00:00Z'),
    })
    expect(prompt).toContain('Today is Saturday, 2026-08-15')
  })

  it('defaults to America/Sao_Paulo when no timezone is given', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      now: new Date('2026-08-16T15:00:00Z'),
    })
    expect(prompt).toContain('Today is Sunday, 2026-08-16')
  })
})

describe('buildSystemPrompt — daily menu', () => {
  it("includes today's menu text when given", () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      dailyMenu: 'Feijoada, arroz, farofa e couve',
    })
    expect(prompt).toContain('Feijoada, arroz, farofa e couve')
  })

  it('omits the menu section entirely when not given', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(prompt).not.toContain("today's menu")
  })

  it('omits the menu section for an empty/whitespace-only string', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft', dailyMenu: '   ' })
    expect(prompt).not.toContain("today's menu")
  })
})

describe('buildSystemPrompt — stale price warning (toolsActive)', () => {
  // Confirmed live (2026-09-06, Concórdia): the model answered "qual valor
  // do rodízio hj" with R$69,90 (Saturday's day_price_override) on a
  // Sunday (correct answer: R$84,90) — echoing a price a HUMAN AGENT had
  // quoted correctly weeks earlier, on an actual Saturday, still visible
  // in this same long-lived WhatsApp thread. A real number, just stale.
  it('warns against reusing an old price from earlier in the conversation when tools are active', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft', toolsActive: true })
    expect(prompt).toMatch(/price.*change.*day of the week/i)
    expect(prompt).toMatch(/never reuse an old price/i)
  })

  it('omits the warning entirely when tools are not active — nothing to call search_menu with', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft', toolsActive: false })
    expect(prompt).not.toMatch(/never reuse an old price/i)
  })
})
