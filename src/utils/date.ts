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
