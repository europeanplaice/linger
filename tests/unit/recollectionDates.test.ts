import { describe, it, expect } from 'vitest'
import { recollectionDatesToPrefetch, recollectionRandomCandidates, buildPeriodicSpecs } from '../../src/utils/recollectionDates'

const TODAY = '2026-05-22'

describe('buildPeriodicSpecs', () => {
  it('returns short-period specs for a new diary (< 1 year)', () => {
    const dates = ['2026-03-01']
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).toContain('week')
    expect(kinds).toContain('month1')
    expect(kinds).not.toContain('year1')
    expect(kinds).not.toContain('year5')
  })

  it('adds year1 spec for a 1–5 year diary', () => {
    const dates = ['2024-01-01']  // ~2.4 years old
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).toContain('week')
    expect(kinds).toContain('year1')
    expect(kinds).not.toContain('year5')
  })

  it('replaces week with year5 for a 5–10 year diary', () => {
    const dates = ['2018-01-01']  // ~8.4 years old
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).not.toContain('week')
    expect(kinds).toContain('year5')
    expect(kinds).not.toContain('year10')
  })

  it('includes year10 and drops short periods for a 10–20 year diary', () => {
    const dates = ['2013-01-01']  // ~13.4 years old
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).not.toContain('week')
    expect(kinds).not.toContain('month1')
    expect(kinds).toContain('year10')
  })

  it('includes year20 for a 20+ year diary', () => {
    const dates = ['2000-01-01']  // ~26 years old
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).toContain('year20')
    expect(kinds).not.toContain('week')
    expect(kinds).not.toContain('month1')
  })

  it('ignores isolated old entries: density window (30% of 12 months) filters outliers', () => {
    // 10 entries: 1 from 15 years ago (1/12 = 8% — below threshold) + 9 from last 2 years
    // Density scan finds the recent cluster as the continuous start (~2–3 years ago)
    // → tier [week, month1, month6, year1], NOT the 10-year tier
    const outlier = '2011-01-01'
    const recent = Array.from({ length: 9 }, (_, i) => `202${4 + (i % 2)}-0${(i % 9) + 1}-01`)
    const specs = buildPeriodicSpecs([outlier, ...recent], TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).toContain('week')
    expect(kinds).toContain('month1')
    expect(kinds).not.toContain('year10')
  })

  it('respects a genuine old writing period: dense old cluster raises the age', () => {
    // 24 entries spread evenly over 10 years (2 per year) → dense enough in each window
    // → tier should include year5 or year10
    const dates = Array.from({ length: 24 }, (_, i) => {
      const year = 2016 + Math.floor(i / 2)
      const month = i % 2 === 0 ? 3 : 9
      return `${year}-${String(month).padStart(2, '0')}-01`
    })
    const specs = buildPeriodicSpecs(dates, TODAY)
    const kinds = specs.map(s => s.kind)
    expect(kinds).toContain('year5')
  })

  it('marks year-level specs with yearTarget', () => {
    const dates = ['2024-01-01']
    const specs = buildPeriodicSpecs(dates, TODAY)
    const year1 = specs.find(s => s.kind === 'year1')
    expect(year1?.yearTarget).toBe(2025)
  })
})

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

  describe('periodic', () => {
    it('includes entries near each active periodic target', () => {
      // Diary age ~1 year → tier [week, month1, month6, year1]
      const weekAgo   = '2026-05-15'  // 7 days, tol 3
      const monthAgo  = '2026-04-22'  // 1 month, tol 10
      const sixMonths = '2025-11-22'  // 6 months, tol 15
      const oneYear   = '2025-05-15'  // ~1 year (7 days from 2025-05-22), tol 30
      const result = recollectionDatesToPrefetch(
        [weekAgo, monthAgo, sixMonths, oneYear],
        TODAY,
      )
      expect(result).toContain(weekAgo)
      expect(result).toContain(monthAgo)
      expect(result).toContain(sixMonths)
      expect(result).toContain(oneYear)
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
      // 2025-05-22 is onThisDay AND year1's target year — should appear exactly once
      const dates = ['2025-05-22']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result.filter(d => d === '2025-05-22')).toHaveLength(1)
    })

    it('skips year-level periodic spec when On This Day already covers that year', () => {
      // 2025-05-22 is onThisDay → year1 (yearTarget=2025) should be suppressed
      // 2025-05-10 is near year1 target but should NOT appear because year is covered
      const dates = ['2025-05-22', '2025-05-10']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain('2025-05-22')   // onThisDay
      expect(result).not.toContain('2025-05-10')  // periodic year1 suppressed
    })

    it('includes 5-year milestone for a 5+ year diary', () => {
      // TODAY = 2026-05-22. 5 years ago = 2021-05-22.
      const fiveYearsAgo = '2021-05-20'   // 2 days from target, within tol 45
      const dates = ['2018-01-01', fiveYearsAgo]  // diary age ~8.4 years
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain(fiveYearsAgo)
    })

    it('includes 10-year milestone for a 10+ year diary', () => {
      // TODAY = 2026-05-22. 10 years ago = 2016-05-22.
      const tenYearsAgo = '2016-05-10'  // 12 days from target, within tol 60
      const dates = ['2010-01-01', tenYearsAgo]  // diary age ~16.4 years
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result).toContain(tenYearsAgo)
    })
  })

  describe('deduplication', () => {
    it('returns each date at most once even when it qualifies in multiple categories', () => {
      // 2025-05-22 qualifies as onThisDay AND as a periodic target (~1 year ago)
      const dates = ['2025-05-22']
      const result = recollectionDatesToPrefetch(dates, TODAY)
      expect(result.filter(d => d === '2025-05-22')).toHaveLength(1)
    })
  })
})

describe('recollectionRandomCandidates', () => {
  it('returns empty array for empty dates', () => {
    expect(recollectionRandomCandidates([], TODAY)).toEqual([])
  })

  it('excludes today', () => {
    expect(recollectionRandomCandidates([TODAY], TODAY)).toEqual([])
  })

  it('excludes onThisDay and periodic dates', () => {
    const onThisDay = '2025-05-22'
    const periodic  = '2026-05-15' // 7 days ago, within tolerance
    const candidate = '2024-01-01' // far from all periodic buckets and different month/day
    const result = recollectionRandomCandidates([onThisDay, periodic, candidate], TODAY)
    expect(result).not.toContain(onThisDay)
    expect(result).not.toContain(periodic)
    expect(result).toContain(candidate)
  })

  it('returns all dates that are not today/onThisDay/periodic', () => {
    const a = '2023-06-15'
    const b = '2022-08-20'
    const result = recollectionRandomCandidates([a, b], TODAY)
    expect(result).toContain(a)
    expect(result).toContain(b)
  })
})
