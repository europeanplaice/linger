import { describe, it, expect } from 'vitest'
import { recollectionHint } from '../../src/utils/recollectionHint'

const TODAY = '2026-06-25'

describe('recollectionHint', () => {
  it('returns null when there are no diary entries', () => {
    expect(recollectionHint([], TODAY)).toBeNull()
  })

  it('returns null when the only entry is today', () => {
    expect(recollectionHint([TODAY], TODAY)).toBeNull()
  })

  it('returns null when the only entry is in the future', () => {
    expect(recollectionHint(['2027-01-01'], TODAY)).toBeNull()
  })

  it('returns null when there are past entries but none in the prefetch window', () => {
    // One isolated entry 3 days ago — not in any periodic window and not on-this-day
    expect(recollectionHint(['2026-06-22'], TODAY)).toBeNull()
  })

  describe('onThisDay kind', () => {
    it('picks the most recent on-this-day entry', () => {
      const dates = ['2025-06-25', '2024-06-25', '2023-06-25']
      const hint = recollectionHint(dates, TODAY)
      expect(hint?.kind).toBe('onThisDay')
      if (hint?.kind === 'onThisDay') {
        expect(hint.yearsAgo).toBe(1)
      }
    })

    it('reports moreCount for additional on-this-day entries', () => {
      const dates = ['2025-06-25', '2024-06-25', '2023-06-25']
      const hint = recollectionHint(dates, TODAY)
      expect(hint?.kind).toBe('onThisDay')
      if (hint?.kind === 'onThisDay') {
        expect(hint.moreCount).toBe(2)
      }
    })

    it('sets moreCount to 0 when there is exactly one on-this-day entry', () => {
      const hint = recollectionHint(['2024-06-25'], TODAY)
      expect(hint?.kind).toBe('onThisDay')
      if (hint?.kind === 'onThisDay') {
        expect(hint.yearsAgo).toBe(2)
        expect(hint.moreCount).toBe(0)
      }
    })

    it('prefers onThisDay over periodic-only', () => {
      // Both an on-this-day entry AND a periodic entry exist
      const dates = ['2025-06-25', '2025-05-25']  // on-this-day + ~1 month ago
      const hint = recollectionHint(dates, TODAY)
      expect(hint?.kind).toBe('onThisDay')
    })
  })

  describe('count kind', () => {
    it('falls back to count when there are periodic entries but no on-this-day', () => {
      // Entry close to 1 year ago but not on June 25 — matches the year1 periodic window
      // (year1 target = 2025-06-25, tol = 30 days; Jun 20 is 5 days off)
      const hint = recollectionHint(['2025-06-20'], TODAY)
      expect(hint?.kind).toBe('count')
      if (hint?.kind === 'count') {
        expect(hint.count).toBeGreaterThan(0)
      }
    })
  })
})
