import {
  todayYmd,
  parseYmd,
  ymd,
  addMonths,
  daysInMonth,
  sameMonthDayInPastYears,
  nearestEntryWithin,
} from './date'

/** Returns the deterministic dates that RecollectionJourney will display
 * (onThisDay + periodic). Used to prefetch content before the modal opens. */
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
    { target: shiftDays(7),    tol: 3 },
    { target: shiftMonths(1),  tol: 7 },
    { target: shiftMonths(6),  tol: 10 },
    { target: shiftMonths(12), tol: 14 },
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

  return [...new Set([...onThisDay, ...periodic])]
}

/** Returns dates eligible for the serendipity (random) slot. */
export function recollectionRandomCandidates(dates: string[], today = todayYmd()): string[] {
  const deterministic = new Set([today, ...recollectionDatesToPrefetch(dates, today)])
  return dates.filter(d => !deterministic.has(d))
}
