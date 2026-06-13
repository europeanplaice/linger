import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { todayYmd, yesterdayYmd, ymd, parseYmd, dateFromYmd, weekdayLabel, diaryDateLabel, diaryDateParts, daysInMonth, addMonths, formatRevisionTime, sameMonthDayInPastYears, nearestEntryWithin, nearestWithDistance, consecutiveWeekStreak, consecutiveMonthStreak, anniversariesNearEntry } from '../../src/utils/date'

describe('date utils', () => {
  describe('todayYmd', () => {
    it('returns date string in YYYY-MM-DD format', () => {
      const result = todayYmd()
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('returns consistent result within same day', () => {
      const mockDate = new Date('2026-05-15T10:30:00')
      vi.useFakeTimers()
      vi.setSystemTime(mockDate)

      const result = todayYmd()
      expect(result).toBe('2026-05-15')

      vi.useRealTimers()
    })
  })

  describe('yesterdayYmd', () => {
    it('returns the day before today', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-15T10:30:00'))
      expect(yesterdayYmd()).toBe('2026-05-14')
      vi.useRealTimers()
    })

    it('crosses month boundary correctly', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-01T08:00:00'))
      expect(yesterdayYmd()).toBe('2026-04-30')
      vi.useRealTimers()
    })

    it('crosses year boundary correctly', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:01:00'))
      expect(yesterdayYmd()).toBe('2025-12-31')
      vi.useRealTimers()
    })

    it('is always one day before todayYmd', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-10T12:00:00'))
      const today = todayYmd()
      const yesterday = yesterdayYmd()
      const [ty, tm, td] = today.split('-').map(Number)
      const [yy, ym, yd] = yesterday.split('-').map(Number)
      const todayDate = new Date(ty, tm - 1, td)
      const yesterdayDate = new Date(yy, ym - 1, yd)
      expect(todayDate.getTime() - yesterdayDate.getTime()).toBe(24 * 60 * 60 * 1000)
      vi.useRealTimers()
    })
  })

  describe('ymd', () => {
    it('formats date correctly', () => {
      expect(ymd(2026, 5, 15)).toBe('2026-05-15')
      expect(ymd(2026, 12, 1)).toBe('2026-12-01')
      expect(ymd(2026, 1, 31)).toBe('2026-01-31')
    })

    it('pads single digits with zero', () => {
      expect(ymd(2026, 3, 5)).toBe('2026-03-05')
    })
  })

  describe('parseYmd', () => {
    it('parses valid date strings', () => {
      expect(parseYmd('2026-05-15')).toEqual({ y: 2026, m: 5, d: 15 })
      expect(parseYmd('2026-12-01')).toEqual({ y: 2026, m: 12, d: 1 })
    })

    it('returns null for invalid format', () => {
      expect(parseYmd('2026/05/15')).toBeNull()
      expect(parseYmd('26-05-15')).toBeNull()
      expect(parseYmd('abc')).toBeNull()
      expect(parseYmd('')).toBeNull()
    })

    it('rejects invalid dates like 2026-02-30', () => {
      expect(parseYmd('2026-02-30')).toBeNull()
      expect(parseYmd('2026-13-01')).toBeNull()
      expect(parseYmd('2026-00-15')).toBeNull()
      expect(parseYmd('2026-04-31')).toBeNull()
    })

    it('accepts valid edge case dates', () => {
      expect(parseYmd('2026-02-28')).toEqual({ y: 2026, m: 2, d: 28 })
      expect(parseYmd('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 }) // leap year
      expect(parseYmd('2026-12-31')).toEqual({ y: 2026, m: 12, d: 31 })
    })
  })

  describe('dateFromYmd', () => {
    it('creates Date object for valid date', () => {
      const d = dateFromYmd('2026-05-15')
      expect(d).toBeInstanceOf(Date)
      expect(d?.getFullYear()).toBe(2026)
      expect(d?.getMonth()).toBe(4) // 0-indexed
      expect(d?.getDate()).toBe(15)
    })

    it('returns null for invalid date string', () => {
      expect(dateFromYmd('invalid')).toBeNull()
      expect(dateFromYmd('2026-02-30')).toBeNull()
    })
  })

  describe('weekdayLabel', () => {
    it('returns correct weekday abbreviation', () => {
      expect(weekdayLabel('2026-05-15')).toBe('金') // May 15, 2026 is Friday
      expect(weekdayLabel('2026-05-16')).toBe('土')
      expect(weekdayLabel('2026-05-17')).toBe('日')
    })

    it('supports English locale', () => {
      expect(weekdayLabel('2026-05-15', 'en-US')).toBe('Fri')
    })

    it('returns empty string for invalid date', () => {
      expect(weekdayLabel('invalid')).toBe('')
    })
  })

  describe('diaryDateLabel', () => {
    it('formats date with long month by default', () => {
      const result = diaryDateLabel('2026-05-15')
      expect(result).toContain('5月')
      expect(result).toContain('15')
    })

    it('includes year for current year by default', () => {
      const currentYear = new Date().getFullYear()
      const result = diaryDateLabel(`${currentYear}-05-15`)
      expect(result).toContain(String(currentYear))
    })

    it('omits year for current year when omitCurrentYear=true', () => {
      const currentYear = new Date().getFullYear()
      const result = diaryDateLabel(`${currentYear}-05-15`, true, 'long', undefined, true)
      expect(result).not.toContain(String(currentYear))
    })

    it('includes year for past years even when omitCurrentYear=true', () => {
      const result = diaryDateLabel('2025-05-15', true, 'long', 'en-US', true)
      expect(result).toContain('2025')
    })

    it('can use short month format', () => {
      const result = diaryDateLabel('2026-05-15', true, 'short')
      expect(result).toContain('5月')
    })

    it('supports English locale', () => {
      const result = diaryDateLabel('2026-05-15', true, 'long', 'en-US')
      expect(result).toContain('May')
      expect(result).toContain('15')
    })

    it('omits year when includeYear is false', () => {
      const withYear = diaryDateLabel('2025-05-15', true)
      const withoutYear = diaryDateLabel('2025-05-15', false)
      expect(withYear.length).toBeGreaterThan(withoutYear.length)
    })

    it('omitCurrentYear has no effect when includeYear is false', () => {
      const withoutYear = diaryDateLabel('2025-05-15', false)
      const withoutYearAndOmit = diaryDateLabel('2025-05-15', false, 'long', undefined, true)
      expect(withoutYear).toBe(withoutYearAndOmit)
    })

    it('returns original string for invalid date', () => {
      expect(diaryDateLabel('invalid')).toBe('invalid')
    })

    describe('year boundary with omitCurrentYear=true', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('omits year for Dec 31 entry when current date is Dec 31 same year', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2025-12-31T23:59:59'))
        const result = diaryDateLabel('2025-12-31', true, 'long', 'en-US', true)
        expect(result).not.toContain('2025')
      })

      it('shows year for Dec 31 entry after midnight on Jan 1 next year', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00'))
        const result = diaryDateLabel('2025-12-31', true, 'long', 'en-US', true)
        expect(result).toContain('2025')
      })

      it('shows year for Jan 1 future entry when current date is Dec 31 prior year', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2025-12-31T23:59:59'))
        const result = diaryDateLabel('2026-01-01', true, 'long', 'en-US', true)
        expect(result).toContain('2026')
      })

      it('always shows year when omitCurrentYear=false regardless of year match', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2025-12-31T23:59:59'))
        const result = diaryDateLabel('2025-12-31', true, 'long', 'en-US', false)
        expect(result).toContain('2025')
      })
    })
  })

  describe('diaryDateParts', () => {
    it('splits Japanese dates with the year first', () => {
      const result = diaryDateParts('2025-06-02', 'ja-JP')
      expect(result.year).toBe('2025年')
      expect(result.monthDay).toBe('6月2日')
      expect(result.yearFirst).toBe(true)
    })

    it('splits English dates with the year last', () => {
      const result = diaryDateParts('2025-06-02', 'en-US')
      expect(result.year).toBe('2025')
      expect(result.monthDay).toBe('June 2')
      expect(result.yearFirst).toBe(false)
    })

    it('omits the year for current-year dates when omitCurrentYear=true', () => {
      const currentYear = new Date().getFullYear()
      const result = diaryDateParts(`${currentYear}-06-02`, 'en-US', true)
      expect(result.year).toBeNull()
      expect(result.monthDay).toBe('June 2')
    })

    it('keeps the year for past dates even when omitCurrentYear=true', () => {
      const result = diaryDateParts('2020-06-02', 'en-US', true)
      expect(result.year).toBe('2020')
    })

    it('returns the original string as monthDay for invalid dates', () => {
      expect(diaryDateParts('invalid')).toEqual({ year: null, monthDay: 'invalid', yearFirst: false })
    })
  })

  describe('daysInMonth', () => {
    it('returns correct days for each month', () => {
      expect(daysInMonth(2026, 1)).toBe(31)
      expect(daysInMonth(2026, 2)).toBe(28)
      expect(daysInMonth(2024, 2)).toBe(29) // leap year
      expect(daysInMonth(2026, 4)).toBe(30)
      expect(daysInMonth(2026, 12)).toBe(31)
    })
  })

  describe('addMonths', () => {
    it('adds months within same year', () => {
      expect(addMonths(2026, 5, 1)).toEqual({ year: 2026, month: 6 })
      expect(addMonths(2026, 11, 1)).toEqual({ year: 2026, month: 12 })
    })

    it('handles negative delta', () => {
      expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
      expect(addMonths(2026, 5, -6)).toEqual({ year: 2025, month: 11 })
    })

    it('handles large deltas', () => {
      expect(addMonths(2026, 6, 12)).toEqual({ year: 2027, month: 6 })
      expect(addMonths(2026, 6, -12)).toEqual({ year: 2025, month: 6 })
    })

    it('handles multi-year transitions', () => {
      expect(addMonths(2026, 1, 25)).toEqual({ year: 2028, month: 2 })
      expect(addMonths(2026, 12, -13)).toEqual({ year: 2025, month: 11 })
    })
  })

  describe('formatRevisionTime', () => {
    const NOW = new Date('2026-05-15T14:30:00')

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

     it('shows localized today for same-day revisions', () => {
       const result = formatRevisionTime('2026-05-15T09:15:00', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(result).toMatch(/^今日 \d{2}:\d{2}$/)
     })

     it('shows localized yesterday for previous day revisions', () => {
       const result = formatRevisionTime('2026-05-14T18:45:00', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(result).toMatch(/^昨日 \d{2}:\d{2}$/)
     })

     it('shows localized date and time for same-year but not today/yesterday', () => {
       const result = formatRevisionTime('2026-05-10T10:00:00', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(result).toMatch(/^5月10日, \d{2}:\d{2}$/)
     })

     it('shows full date with year for previous years', () => {
       const result = formatRevisionTime('2025-12-25T08:30:00', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(result).toMatch(/^2025年12月25日, \d{2}:\d{2}$/)
     })

     it('supports English locale and labels', () => {
       const result = formatRevisionTime('2026-05-15T09:15:00', 'en-US', { today: 'Today', yesterday: 'Yesterday' })
       expect(result).toMatch(/^Today \d{1,2}:\d{2} [AP]M$/)
     })

     it('uses local day boundaries (timezone-safe)', () => {
       // Just before midnight - should NOT be "Today"
       const justBeforeMidnight = formatRevisionTime('2026-05-14T23:59:59', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(justBeforeMidnight).toMatch(/^昨日/)

       // Just after midnight - should be "Today"
       const justAfterMidnight = formatRevisionTime('2026-05-15T00:00:01', 'ja-JP', { today: '今日', yesterday: '昨日' })
       expect(justAfterMidnight).toMatch(/^今日/)
     })
  })

  describe('sameMonthDayInPastYears', () => {
    it('returns same month/day in earlier years, most recent first', () => {
      const dates = ['2026-05-22', '2025-05-22', '2023-05-22', '2024-05-21', '2024-06-22']
      expect(sameMonthDayInPastYears(dates, '2026-05-22')).toEqual(['2025-05-22', '2023-05-22'])
    })

    it('excludes the current year and future years', () => {
      const dates = ['2026-05-22', '2027-05-22']
      expect(sameMonthDayInPastYears(dates, '2026-05-22')).toEqual([])
    })

    it('matches across year boundary (Jan 1)', () => {
      const dates = ['2025-01-01', '2024-01-01', '2024-12-31']
      expect(sameMonthDayInPastYears(dates, '2026-01-01')).toEqual(['2025-01-01', '2024-01-01'])
    })

    it('only matches Feb 29 when today is Feb 29', () => {
      const dates = ['2024-02-29', '2020-02-29']
      expect(sameMonthDayInPastYears(dates, '2025-02-28')).toEqual([])
      expect(sameMonthDayInPastYears(dates, '2028-02-29')).toEqual(['2024-02-29', '2020-02-29'])
    })

    it('returns empty when nothing matches', () => {
      expect(sameMonthDayInPastYears(['2025-03-10'], '2026-05-22')).toEqual([])
    })
  })

  describe('nearestEntryWithin', () => {
    it('returns the closest entry within the window', () => {
      const dates = ['2026-05-10', '2026-05-14', '2026-05-20']
      expect(nearestEntryWithin(dates, '2026-05-15', 3)).toBe('2026-05-14')
    })

    it('returns null when nothing is within the window', () => {
      expect(nearestEntryWithin(['2026-05-01'], '2026-05-15', 3)).toBeNull()
    })

    it('prefers an exact match', () => {
      expect(nearestEntryWithin(['2026-05-14', '2026-05-15'], '2026-05-15', 5)).toBe('2026-05-15')
    })

    it('prefers the earlier (past) date on a tie, regardless of input order', () => {
      expect(nearestEntryWithin(['2026-05-18', '2026-05-12'], '2026-05-15', 5)).toBe('2026-05-12')
      expect(nearestEntryWithin(['2026-05-12', '2026-05-18'], '2026-05-15', 5)).toBe('2026-05-12')
    })
  })

  describe('nearestWithDistance', () => {
    it('returns date and distance 0 for an exact match', () => {
      expect(nearestWithDistance(['2026-05-15'], '2026-05-15', 5)).toEqual({ date: '2026-05-15', distance: 0 })
    })

    it('returns the correct distance for an offset entry', () => {
      const dates = ['2026-05-10', '2026-05-14', '2026-05-20']
      expect(nearestWithDistance(dates, '2026-05-15', 3)).toEqual({ date: '2026-05-14', distance: 1 })
    })

    it('returns null when nothing is within the window', () => {
      expect(nearestWithDistance(['2026-05-01'], '2026-05-15', 3)).toBeNull()
    })

    it('prefers the earlier (past) date on a tie and reports the shared distance', () => {
      expect(nearestWithDistance(['2026-05-18', '2026-05-12'], '2026-05-15', 5)).toEqual({ date: '2026-05-12', distance: 3 })
    })
  })

  describe('anniversariesNearEntry', () => {
    it('finds annual occurrences across a year boundary', () => {
      expect(anniversariesNearEntry('2026-01-02', [
        { id: 'new-year', label: 'New Year', date: '2000-01-01' },
        { id: 'year-end', label: 'Year End', date: '2000-12-31' },
      ])).toEqual([
        { id: 'new-year', label: 'New Year', monthDay: '01-01', distance: -1 },
        { id: 'year-end', label: 'Year End', monthDay: '12-31', distance: -2 },
      ])
    })

    it('keeps distinct identities for anniversaries on the same day', () => {
      expect(anniversariesNearEntry('2026-05-10', [
        { id: 'a', label: 'First', date: '2000-05-10' },
        { id: 'b', label: 'Second', date: '2001-05-10' },
      ])).toEqual([
        { id: 'a', label: 'First', monthDay: '05-10', distance: 0 },
        { id: 'b', label: 'Second', monthDay: '05-10', distance: 0 },
      ])
    })
  })

  describe('consecutiveMonthStreak', () => {
    it('counts consecutive months back from the most recent entry', () => {
      const dates = ['2026-03-04', '2026-04-19', '2026-05-01', '2026-05-22']
      expect(consecutiveMonthStreak(dates)).toBe(3)
    })

    it('breaks the streak on a gap month', () => {
      const dates = ['2026-01-10', '2026-03-10', '2026-04-10']
      expect(consecutiveMonthStreak(dates)).toBe(2)
    })

    it('crosses the year boundary', () => {
      const dates = ['2025-11-30', '2025-12-15', '2026-01-05']
      expect(consecutiveMonthStreak(dates)).toBe(3)
    })

    it('returns 0 for no entries', () => {
      expect(consecutiveMonthStreak([])).toBe(0)
    })
  })

  describe('consecutiveWeekStreak', () => {
    it('counts consecutive Monday-based weeks back from the most recent entry', () => {
      // 2026-05-22 (Fri) week, 2026-05-15 week, 2026-05-08 week
      const dates = ['2026-05-08', '2026-05-15', '2026-05-22']
      expect(consecutiveWeekStreak(dates)).toBe(3)
    })

    it('treats same-week entries as one week', () => {
      const dates = ['2026-05-18', '2026-05-20', '2026-05-22'] // all same ISO week
      expect(consecutiveWeekStreak(dates)).toBe(1)
    })

    it('breaks on a skipped week', () => {
      const dates = ['2026-05-01', '2026-05-15', '2026-05-22']
      expect(consecutiveWeekStreak(dates)).toBe(2)
    })

    it('returns 0 for no entries', () => {
      expect(consecutiveWeekStreak([])).toBe(0)
    })
  })
})
