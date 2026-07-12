import { describe, it, expect } from 'vitest'
import { buildDynamicPrompts } from '../../src/utils/dynamicPrompts'

const baseCtx = {
  date: '2026-07-15', // a Wednesday (midweek), summer
  knownDates: [] as string[],
  milestones: [],
  language: 'en' as const,
}

describe('buildDynamicPrompts', () => {
  it('always includes a season prompt as a baseline', () => {
    const prompts = buildDynamicPrompts(baseCtx)
    expect(prompts.length).toBeGreaterThanOrEqual(1)
  })

  it('adds a milestone prompt when a recurring milestone is within range', () => {
    const prompts = buildDynamicPrompts({
      ...baseCtx,
      milestones: [{ id: 'bday', label: 'Sam’s birthday', date: '2019-07-18', recurring: true }],
    })
    expect(prompts.some(p => p.includes('Sam’s birthday'))).toBe(true)
  })

  it('adds a gap-since-last-entry prompt tiered by how long it has been', () => {
    const short = buildDynamicPrompts({ ...baseCtx, knownDates: ['2026-07-12'] })
    expect(short.some(p => p.includes('3 days'))).toBe(true)

    const long = buildDynamicPrompts({ ...baseCtx, date: '2026-08-20', knownDates: ['2026-07-12'] })
    expect(long.some(p => /\d+ days/.test(p))).toBe(true)
  })

  it('omits the gap prompt for a 1-2 day gap (not noteworthy)', () => {
    const prompts = buildDynamicPrompts({ ...baseCtx, knownDates: ['2026-07-14'] })
    expect(prompts.some(p => p.toLowerCase().includes('last entry'))).toBe(false)
  })

  it('adds a streak prompt once the streak reaches 3 days', () => {
    const prompts = buildDynamicPrompts({
      ...baseCtx,
      knownDates: ['2026-07-12', '2026-07-13', '2026-07-14'],
    })
    expect(prompts.some(p => p.includes('3 days in a row'))).toBe(true)
  })

  it('adds a weekday-specific prompt for Monday and Friday', () => {
    const monday = buildDynamicPrompts({ ...baseCtx, date: '2026-07-13' })
    expect(monday.some(p => p.toLowerCase().includes('monday'))).toBe(true)

    const friday = buildDynamicPrompts({ ...baseCtx, date: '2026-07-17' })
    expect(friday.some(p => p.toLowerCase().includes('friday'))).toBe(true)
  })

  it('adds a weekend prompt on Saturday and Sunday', () => {
    const saturday = buildDynamicPrompts({ ...baseCtx, date: '2026-07-18' })
    expect(saturday.some(p => p.toLowerCase().includes('weekend'))).toBe(true)

    const sunday = buildDynamicPrompts({ ...baseCtx, date: '2026-07-19' })
    expect(sunday.some(p => p.toLowerCase().includes('weekend'))).toBe(true)
  })

  it('adds a holiday prompt when one is provided for the date', () => {
    const prompts = buildDynamicPrompts({
      ...baseCtx,
      holiday: { localName: 'Marine Day', name: 'Marine Day' },
    })
    expect(prompts.some(p => p.includes('Marine Day'))).toBe(true)
  })

  it('adds a recurring-topic prompt when one is supplied', () => {
    const prompts = buildDynamicPrompts({
      ...baseCtx,
      recurringTopic: { term: 'pottery', count: 3, lastSeenDate: '2026-05-01' },
    })
    expect(prompts.some(p => p.includes('pottery'))).toBe(true)
  })

  it('falls back to Japanese templates for language "ja"', () => {
    const prompts = buildDynamicPrompts({ ...baseCtx, language: 'ja' })
    expect(prompts.some(p => /[ぁ-んァ-ヿ一-鿿]/.test(p))).toBe(true)
  })

  it('adds a prompt referencing a word from the entry once it has content', () => {
    const prompts = buildDynamicPrompts({
      ...baseCtx,
      currentText: 'Had ramen with my coworker after the meeting.',
    })
    expect(prompts.some(p => p.includes('coworker'))).toBe(true)
  })

  it('omits the mentioned-topic prompt when there is no current text', () => {
    // baseCtx has no other active signal (no milestone/gap/streak/weekday/
    // holiday/recurring topic for this date), so the only baseline prompt is
    // the always-on season one — checked by count rather than by matching
    // template wording, so this doesn't silently pass once that wording changes.
    const withText = buildDynamicPrompts({ ...baseCtx, currentText: 'Had ramen with my coworker.' })
    const withoutText = buildDynamicPrompts(baseCtx)
    expect(withText.length).toBe(withoutText.length + 1)
    expect(withoutText).toHaveLength(1)
  })
})
