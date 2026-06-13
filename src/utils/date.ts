import type { AnniversaryProximity } from '../types'

export const DEFAULT_DATE_LOCALE = 'ja-JP'

export function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function yesterdayYmd(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ymd(year: number, month1to12: number, day: number): string {
  return `${year}-${String(month1to12).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function shiftDate(date: string, days: number): string {
  const parts = parseYmd(date)
  const d = parts ? new Date(parts.y, parts.m - 1, parts.d) : new Date()
  d.setDate(d.getDate() + days)
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

export function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  // Validate: create local date and verify components match (rejects 2026-02-30 etc.)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return { y, m, d }
}

export function dateFromYmd(s: string): Date | null {
  const parts = parseYmd(s)
  return parts ? new Date(parts.y, parts.m - 1, parts.d) : null
}

export function weekdayLabel(date: string, locale = DEFAULT_DATE_LOCALE): string {
  const d = dateFromYmd(date)
  if (!d) return ''

  return d.toLocaleDateString(locale, { weekday: 'short' })
}

function isSameYear(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
}

export interface DiaryDateParts {
  year: string | null // "2025年" / "2025", null when omitted
  monthDay: string // "6月2日" / "June 2"
  yearFirst: boolean // ja=true, en=false
}

/**
 * Split a diary date into year / month-day segments so the header can flex-wrap
 * them (e.g. drop the year to its own line on narrow screens) instead of clipping.
 * Each Intl sub-format yields the locale-correct piece, so no literal parsing is needed.
 */
export function diaryDateParts(date: string, locale = DEFAULT_DATE_LOCALE, omitCurrentYear = false): DiaryDateParts {
  const d = dateFromYmd(date)
  if (!d) return { year: null, monthDay: date, yearFirst: false }

  const monthDay = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(d)
  const showYear = !(omitCurrentYear && isSameYear(d, new Date()))
  if (!showYear) return { year: null, monthDay, yearFirst: false }

  const year = new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(d)
  const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(d)
  const yi = parts.findIndex(p => p.type === 'year')
  const mi = parts.findIndex(p => p.type === 'month')
  return { year, monthDay, yearFirst: yi < mi }
}

export function diaryDateLabel(date: string, includeYear = true, month: 'long' | 'short' = 'long', locale = DEFAULT_DATE_LOCALE, omitCurrentYear = false): string {
  const d = dateFromYmd(date)
  if (!d) return date

  const showYear = includeYear && !(omitCurrentYear && isSameYear(d, new Date()))
  return d.toLocaleDateString(locale, {
    month,
    day: 'numeric',
    ...(showYear ? { year: 'numeric' as const } : {}),
  })
}

/**
 * From a list of YYYY-MM-DD dates, return those falling on the same month/day
 * as `today` but in an earlier year, sorted most-recent year first.
 */
export function sameMonthDayInPastYears(dates: string[], today: string = todayYmd()): string[] {
  const ref = parseYmd(today)
  if (!ref) return []
  return dates
    .map(parseYmd)
    .filter((p): p is { y: number; m: number; d: number } => p !== null && p.m === ref.m && p.d === ref.d && p.y < ref.y)
    .sort((a, b) => b.y - a.y)
    .map(p => ymd(p.y, p.m, p.d))
}

/**
 * Find the entry date closest to `target` (YYYY-MM-DD), within `maxDistanceDays`.
 * Returns null if no entry falls inside the window.
 */
export function nearestWithDistance(dates: string[], target: string, maxDistanceDays: number): { date: string; distance: number } | null {
  const t = dateFromYmd(target)
  if (!t) return null
  let best: string | null = null
  let bestDist = Infinity
  for (const d of dates) {
    const dd = dateFromYmd(d)
    if (!dd) continue
    const dist = Math.abs(Math.round((dd.getTime() - t.getTime()) / 86_400_000))
    if (dist > maxDistanceDays) continue
    // On a tie, prefer the earlier (past) date so a "while ago" look-back
    // never jumps to a future entry.
    if (dist < bestDist || (dist === bestDist && best !== null && d.localeCompare(best) < 0)) {
      bestDist = dist
      best = d
    }
  }
  return best !== null ? { date: best, distance: bestDist } : null
}

export function nearestEntryWithin(dates: string[], target: string, maxDistanceDays: number): string | null {
  return nearestWithDistance(dates, target, maxDistanceDays)?.date ?? null
}

export function anniversaryProximity(
  entryDate: string,
  anniversaryDate: string,
  id: string,
  label: string,
): AnniversaryProximity | null {
  const entry = parseYmd(entryDate)
  const anniversary = parseYmd(anniversaryDate)
  if (!entry || !anniversary) return null

  const entryDay = Date.UTC(entry.y, entry.m - 1, entry.d)
  const anniversaryDay = Date.UTC(anniversary.y, anniversary.m - 1, anniversary.d)
  const distance = Math.round((anniversaryDay - entryDay) / 86_400_000)

  return { id, label, date: anniversaryDate, distance }
}

export function anniversariesNearEntry(
  entryDate: string,
  anniversaries: ReadonlyArray<{ id: string; label: string; date: string }>,
  maxDistanceDays?: number,
): AnniversaryProximity[] {
  const results: AnniversaryProximity[] = []
  for (const a of anniversaries) {
    const prox = anniversaryProximity(entryDate, a.date, a.id, a.label)
    if (prox && (maxDistanceDays === undefined || Math.abs(prox.distance) <= maxDistanceDays)) {
      results.push(prox)
    }
  }
  results.sort((a, b) => a.date.localeCompare(b.date))
  return results
}

function mondayStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - offset)
  return d
}

function latestParsed(dates: string[]): string | null {
  let latest: string | null = null
  for (const d of dates) {
    if (!parseYmd(d)) continue
    if (latest === null || d.localeCompare(latest) > 0) latest = d
  }
  return latest
}

/**
 * Number of consecutive ISO weeks (Monday-based) with at least one entry,
 * counting back from the most recent entry's week.
 */
export function consecutiveWeekStreak(dates: string[]): number {
  const latest = latestParsed(dates)
  if (!latest) return 0

  const weekKeys = new Set<string>()
  for (const d of dates) {
    const dd = dateFromYmd(d)
    if (!dd) continue
    const m = mondayStart(dd)
    weekKeys.add(ymd(m.getFullYear(), m.getMonth() + 1, m.getDate()))
  }

  const cursor = mondayStart(dateFromYmd(latest)!)
  let streak = 0
  for (;;) {
    const key = ymd(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())
    if (!weekKeys.has(key)) break
    streak += 1
    cursor.setDate(cursor.getDate() - 7)
  }
  return streak
}

/**
 * Number of consecutive calendar months with at least one entry,
 * counting back from the most recent entry's month.
 */
export function consecutiveMonthStreak(dates: string[]): number {
  const latest = latestParsed(dates)
  if (!latest) return 0

  const monthKeys = new Set<string>()
  for (const d of dates) {
    const p = parseYmd(d)
    if (p) monthKeys.add(`${p.y}-${String(p.m).padStart(2, '0')}`)
  }

  let { y, m } = parseYmd(latest)!
  let streak = 0
  for (;;) {
    if (!monthKeys.has(`${y}-${String(m).padStart(2, '0')}`)) break
    streak += 1
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return streak
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate()
}

export function addMonths(year: number, month1to12: number, delta: number): { year: number; month: number } {
  const total = month1to12 - 1 + delta
  const y = year + Math.floor(total / 12)
  const m = ((total % 12) + 12) % 12 + 1
  return { year: y, month: m }
}

/**
 * Format an ISO datetime for revision history display.
 * Uses local day boundaries to avoid timezone edge cases.
 */
export function formatRevisionTime(iso: string, locale = DEFAULT_DATE_LOCALE, labels: { today: string; yesterday: string }): string {
  const d = new Date(iso)
  const now = new Date()

  // Local day boundaries (00:00:00 local time)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const dDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

  if (dDayStart.getTime() === todayStart.getTime()) return `${labels.today} ${time}`
  if (dDayStart.getTime() === yesterdayStart.getTime()) return `${labels.yesterday} ${time}`
  if (isSameYear(d, now)) {
    const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    return `${date}, ${time}`
  }
  const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${date}, ${time}`
}
