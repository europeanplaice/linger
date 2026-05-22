import { describe, it, expect } from 'vitest'
import { recollectionDatesToPrefetch } from '../../src/utils/recollectionDates'

const TODAY = '2026-05-22'

describe('recollectionDatesToPrefetch', () => {
  it('returns empty array for empty dates', () => {
    expect(recollectionDatesToPrefetch([], TODAY)).toEqual([])
  })

  it('excludes today from results', () => {
    expect(recollectionDatesToPrefetch([TODAY], TODAY)).toEqual([])
  })

  describe('onThisDay', () => {
    it('includes same month/day from past years', () => {
      const dates = ['2026-05-22', '2025-05-22', '2024-05-22', '2026-03-21']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain('2025-05-22')
      expect(result).toContain('2024-05-22')
      expect(result).not.toContain('2026-05-22')
      expect(result).not.toContain('2026-03-21')
    })

    it('returns empty when no entries match today\'s month/day in past years', () => {
      expect(recollectionDatesToPrefetch(['2026-01-01'], TODAY)).toEqual([])
    })
  })

  describe('periodic (1 week / 1 month / 3 months / 6 months ago)', () => {
    it('includes entries near each periodic target', () => {
      const weekAgo    = '2026-05-15'  // 7 days, tol 3
      const monthAgo   = '2026-04-22'  // 1 month, tol 7
      const threeMonths = '2026-02-22' // 3 months, tol 8
      const sixMonths  = '2025-11-22'  // 6 months, tol 10
      const result = recollectionDatesToPrefetch(
        [weekAgo, monthAgo, threeMonths, sixMonths],
        TODAY,
      )
      expect(result).toContain(weekAgo)
      expect(result).toContain(monthAgo)
      expect(result).toContain(threeMonths)
      expect(result).toContain(sixMonths)
    })

    it('accepts nearest entry within tolerance', () => {
      // 2026-05-14 is 1 day from the 1-week-ago target (2026-05-15), tolerance 3
      const result = recollectionDatesToPrefetch(['2026-05-14'], TODAY)
      expect(result).toContain('2026-05-14')
    })

    it('excludes entries outside tolerance window', () => {
      // 2026-05-10 is 12 days before today — too far from every periodic target
      const result = recollectionDatesToPrefetch(['2026-05-10'], TODAY)
      expect(result).not.toContain('2026-05-10')
    })

    it('does not add a periodic entry that is already in onThisDay', () => {
      // 2025-05-22 is onThisDay AND could be near the ~1-year periodic target.
      // It should appear exactly once.
      const dates = ['2025-05-22']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result.filter(d => d === '2025-05-22')).toHaveLength(1)
    })
  })

  describe('milestones: nth entry', () => {
    it('includes the 100th entry (ascending) when >= 100 entries exist', () => {
      const start = new Date('2020-01-01')
      const dates = Array.from({ length: 150 }, (_, i) => {
        const d = new Date(start)
        d.setDate(d.getDate() + i)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })
      const ascending = [...dates].sort()
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain(ascending[99])
    })

    it('does not include any milestone date when fewer than 100 entries exist and no other condition holds', () => {
      // 2026-01-01: same year as today → not ≥1 year old; no streak from 1 entry
      const result = recollectionDatesToPrefetch(['2026-01-01'], TODAY)
      expect(result).toEqual([])
    })
  })

  describe('milestones: oldest entry ≥ 1 year', () => {
    it('includes oldest entry when exactly 1 year before today', () => {
      // 2025-05-22 is exactly 1 year before 2026-05-22
      const result = recollectionDatesToPrefetch(['2025-05-22', '2026-03-01'], TODAY)
      expect(result).toContain('2025-05-22')
    })

    it('excludes oldest entry when less than 1 year before today', () => {
      // 2025-05-23 is 364 days before 2026-05-22
      const result = recollectionDatesToPrefetch(['2025-05-23', '2026-03-01'], TODAY)
      expect(result).not.toContain('2025-05-23')
    })
  })

  describe('milestones: streak', () => {
    it('includes most recent entry when month streak ≥ 2', () => {
      // Mar, Apr, May → 3-month streak
      const dates = ['2026-03-15', '2026-04-10', '2026-05-01']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain('2026-05-01')
    })

    it('includes most recent entry when week streak ≥ 2', () => {
      // 2026-05-08 (week of May 4) + 2026-05-15 (week of May 11) → 2-week streak
      const dates = ['2026-05-08', '2026-05-15']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain('2026-05-15')
    })

    it('does not include recent entry for a single-entry streak', () => {
      // Only one entry in May → streak = 1, below threshold
      const result = recollectionDatesToPrefetch(['2026-05-01'], TODAY)
      expect(result).not.toContain('2026-05-01')
    })
  })

  describe('deduplication', () => {
    it('returns each date at most once even when it qualifies in multiple categories', () => {
      // 2025-05-22 qualifies as onThisDay AND as oldest ≥ 1 year
      const dates = ['2025-05-22']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result.filter(d => d === '2025-05-22')).toHaveLength(1)
    })
  })
})
