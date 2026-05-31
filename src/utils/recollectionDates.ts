import {
  todayYmd,
  parseYmd,
  ymd,
  addMonths,
  daysInMonth,
  sameMonthDayInPastYears,
  nearestEntryWithin,
} from './date'

export type PeriodicKind = 'week' | 'month1' | 'month6' | 'year1' | 'year5' | 'year10' | 'year20'

export interface PeriodicSpec {
  target: string
  tol: number
  kind: PeriodicKind
  /** Set for year-level specs; used to skip if On This Day already covers that year. */
  yearTarget?: number
}

/**
 * Returns how many years the user has been actively writing.
 *
 * Uses a sliding 12-month density window: scans from the oldest entry toward
 * today and finds the oldest month where at least 30% of the following 12
 * months contain an entry. An isolated old record (1 entry in 12 months =
 * 8%) stays below the threshold and is ignored.
 *
 * Fallback for very sparse diaries (no window reaches the threshold):
 * uses the 10th-percentile oldest entry instead.
 */
function diaryAgeYears(dates: string[], today: string): number {
  if (dates.length === 0) return 0

  const ref = parseYmd(today)
  if (!ref) return 0

  // Convert each date to "months before today" (0 = this month, 1 = last month…)
  const filledMonths = new Set<number>()
  for (const d of dates) {
    const p = parseYmd(d)
    if (!p) continue
    const ago = (ref.y - p.y) * 12 + (ref.m - p.m)
    if (ago >= 0) filledMonths.add(ago)
  }
  if (filledMonths.size === 0) return 0

  let maxAgo = 0
  for (const m of filledMonths) if (m > maxAgo) maxAgo = m

  const WINDOW = 12
  const THRESHOLD = 0.3

  // Scan from oldest to newest. The first start that passes is the oldest
  // month from which writing was dense enough — the "continuous start".
  for (let start = maxAgo; start >= 0; start--) {
    let filled = 0
    for (let w = 0; w < WINDOW; w++) {
      if (filledMonths.has(start - w)) filled++
    }
    if (filled / WINDOW >= THRESHOLD) return start / 12
  }

  // Fallback: no window reached the density threshold (very sparse diary).
  // Use 10th-percentile oldest entry to avoid a single outlier inflating age.
  const sorted = [...dates].sort()
  const skip = Math.min(Math.floor(sorted.length * 0.1), sorted.length - 1)
  const p = parseYmd(sorted[skip])
  if (!p) return 0
  return (ref.y - p.y) + (ref.m - p.m) / 12
}

/**
 * Returns the periodic specs appropriate for the diary's age.
 * Older diaries get coarser (year-level) specs; newer diaries get finer ones.
 * Caps the total number of potential specs at ~4 so the section stays readable.
 */
export function buildPeriodicSpecs(dates: string[], today = todayYmd()): PeriodicSpec[] {
  const ref = parseYmd(today)
  if (!ref) return []

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
  const shiftYears = (years: number) => shiftMonths(years * 12)

  const age = diaryAgeYears(dates, today)

  const all = {
    week:   { target: shiftDays(7),    tol: 3,   kind: 'week'   as const },
    month1: { target: shiftMonths(1),  tol: 10,  kind: 'month1' as const },
    month6: { target: shiftMonths(6),  tol: 15,  kind: 'month6' as const },
    year1:  { target: shiftYears(1),   tol: 30,  kind: 'year1'  as const, yearTarget: ref.y - 1 },
    year5:  { target: shiftYears(5),   tol: 45,  kind: 'year5'  as const, yearTarget: ref.y - 5 },
    year10: { target: shiftYears(10),  tol: 60,  kind: 'year10' as const, yearTarget: ref.y - 10 },
    year20: { target: shiftYears(20),  tol: 90,  kind: 'year20' as const, yearTarget: ref.y - 20 },
  }

  if (age < 1)   return [all.week, all.month1, all.month6]
  if (age < 5)   return [all.week, all.month1, all.month6, all.year1]
  if (age < 10)  return [all.month1, all.month6, all.year1, all.year5]
  if (age < 20)  return [all.month6, all.year1, all.year5, all.year10]
  return [all.year1, all.year5, all.year10, all.year20]
}

/** Returns the deterministic dates that RecollectionJourney will display
 * (onThisDay + periodic). Used to prefetch content before the modal opens. */
export function recollectionDatesToPrefetch(dates: string[], today = todayYmd()): string[] {
  const ref = parseYmd(today)
  if (!ref || dates.length === 0) return []

  const onThisDay = sameMonthDayInPastYears(dates, today)
  const onThisDayYears = new Set(
    onThisDay.map(d => parseYmd(d)?.y).filter((y): y is number => y !== undefined)
  )

  const specs = buildPeriodicSpecs(dates, today)
  const used = new Set<string>([today, ...onThisDay])
  const periodic: string[] = []

  for (const s of specs) {
    if (s.yearTarget !== undefined && onThisDayYears.has(s.yearTarget)) continue
    const found = nearestEntryWithin(dates, s.target, s.tol)
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
