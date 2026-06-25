import { sameMonthDayInPastYears, parseYmd, todayYmd } from './date'
import { recollectionDatesToPrefetch } from './recollectionDates'

export type RecollectionHint =
  | { kind: 'onThisDay'; yearsAgo: number; moreCount: number }
  | { kind: 'count'; count: number }
  | null

export function recollectionHint(dates: string[], today: string = todayYmd()): RecollectionHint {
  const onThisDay = sameMonthDayInPastYears(dates, today)

  if (onThisDay.length > 0) {
    const ref = parseYmd(today)
    const most = parseYmd(onThisDay[0])
    if (!ref || !most) return null
    return {
      kind: 'onThisDay',
      yearsAgo: ref.y - most.y,
      moreCount: onThisDay.length - 1,
    }
  }

  const prefetch = recollectionDatesToPrefetch(dates, today)
  if (prefetch.length > 0) {
    return { kind: 'count', count: prefetch.length }
  }

  return null
}
