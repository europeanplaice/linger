import {
  todayYmd,
  parseYmd,
  ymd,
  addMonths,
  daysInMonth,
  sameMonthDayInPastYears,
  nearestEntryWithin,
  consecutiveMonthStreak,
  consecutiveWeekStreak,
} from './date'

const MILESTONE_THRESHOLDS = [1000, 500, 365, 100]

function isAtLeastOneYearBefore(date: string, today: string): boolean {
  const p = parseYmd(date)
  const ref = parseYmd(today)
  if (!p || !ref) return false
  if (ref.y - p.y > 1) return true
  if (ref.y - p.y < 1) return false
  return ref.m > p.m || (ref.m === p.m && ref.d >= p.d)
}

/**
 * Returns the deterministic dates that RecollectionJourney will display
 * (onThisDay + periodic + milestones). Used to prefetch content before
 * the modal opens.
 */
export function recollectionDatesToPrefetch(dates: string[], today = todayYmd()): string[] {
  const ref = parseYmd(today)
  if (!ref || dates.length === 0) return []

  const onThisDay = sameMonthDayInPastYears(dates, today)

  const shiftDays = (days: number) => {
    const d = new Date(ref.y, ref.m - 1, ref.d)
    d.setDate(d.getDate() - days)
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  const shiftMonths = (months: number) => {
    const { year, month } = addMonths(ref.y, ref.m, -months)
    const day = Math.min(ref.d, daysInMonth(year, month))
    return ymd(year, month, day)
  }

  const periodicSpecs = [
    { target: shiftDays(7), tol: 3 },
    { target: shiftMonths(1), tol: 7 },
    { target: shiftMonths(3), tol: 8 },
    { target: shiftMonths(6), tol: 10 },
  ]

  const used = new Set<string>([today, ...onThisDay])
  const periodic: string[] = []
  for (const { target, tol } of periodicSpecs) {
    const found = nearestEntryWithin(dates, target, tol)
    if (found && !used.has(found)) {
      used.add(found)
      periodic.push(found)
    }
  }

  const ascending = [...dates].sort((a, b) => a.localeCompare(b))
  const milestones: string[] = []

  for (const n of MILESTONE_THRESHOLDS) {
    if (ascending.length >= n) {
      milestones.push(ascending[n - 1])
      break
    }
  }

  const oldest = ascending[0]
  if (oldest && isAtLeastOneYearBefore(oldest, today)) milestones.push(oldest)

  const recent = ascending[ascending.length - 1]
  if (recent && (consecutiveMonthStreak(dates) >= 2 || consecutiveWeekStreak(dates) >= 2)) {
    milestones.push(recent)
  }

  return [...new Set([...onThisDay, ...periodic, ...milestones])]
}
