import { parseYmd } from './date'
import type { SeenEntry } from './serendipitySeen'

/**
 * Tunable coefficients for the serendipity ("A day, by chance") weighting.
 * Kept in one place so the overall feel can be adjusted easily.
 */
export const WEIGHTS = {
  /** Age: weight = AGE_BASE + sqrt(ageDays / AGE_SCALE). Older entries score higher. */
  AGE_BASE: 0.6,
  AGE_SCALE: 365,
  /** Recently shown: multiplier applied right after an entry was shown… */
  RECENCY_MIN: 0.1,
  /** …recovering linearly back to 1.0 over this many days. */
  RECENCY_RECOVERY_DAYS: 14,
  /** Season: entries within SEASON_WINDOW calendar days of today get up to SEASON_MAX×. */
  SEASON_WINDOW: 30,
  SEASON_MAX: 1.4,
  /** Content: entries known to be empty/very short are nudged down. */
  CONTENT_EMPTY: 0.4,
} as const

/** Whole-day difference between two YYYY-MM-DD dates (a − b), or 0 if unparsable. */
function dayDiff(a: string, b: string): number {
  const pa = parseYmd(a)
  const pb = parseYmd(b)
  if (!pa || !pb) return 0
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d)
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d)
  return Math.round((ta - tb) / 86_400_000)
}

/** Circular day-of-year distance (0–182) between two dates, ignoring year. */
function seasonDistance(a: string, b: string): number {
  const pa = parseYmd(a)
  const pb = parseYmd(b)
  if (!pa || !pb) return 182
  const doy = (p: { y: number; m: number; d: number }) =>
    Math.round((Date.UTC(2001, p.m - 1, p.d) - Date.UTC(2001, 0, 1)) / 86_400_000)
  const diff = Math.abs(doy(pa) - doy(pb))
  return Math.min(diff, 365 - diff)
}

export interface WeightOpts {
  today: string
  recentlyShown?: SeenEntry[]
  /** Dates known (from already-loaded previews) to be empty/very short. */
  emptyDates?: Set<string>
  /** Current time in ms; injectable for deterministic tests. Defaults to Date.now(). */
  now?: number
}

/**
 * Weight for a single serendipity candidate. Always > 0 so every candidate stays
 * reachable. Combines: older-favoring age, a recently-shown penalty that recovers
 * over time, a mild same-season boost, and a small empty-content nudge.
 */
export function serendipityWeight(date: string, opts: WeightOpts): number {
  const ageDays = Math.max(0, dayDiff(opts.today, date))
  const ageFactor = WEIGHTS.AGE_BASE + Math.sqrt(ageDays / WEIGHTS.AGE_SCALE)

  let recencyPenalty = 1
  const seen = opts.recentlyShown?.find(s => s.date === date)
  if (seen) {
    const now = opts.now ?? Date.now()
    const daysSince = (now - seen.ts) / 86_400_000
    const t = Math.min(1, Math.max(0, daysSince / WEIGHTS.RECENCY_RECOVERY_DAYS))
    recencyPenalty = WEIGHTS.RECENCY_MIN + (1 - WEIGHTS.RECENCY_MIN) * t
  }

  const sd = seasonDistance(opts.today, date)
  const seasonFactor =
    sd >= WEIGHTS.SEASON_WINDOW
      ? 1
      : 1 + (WEIGHTS.SEASON_MAX - 1) * (1 - sd / WEIGHTS.SEASON_WINDOW)

  const contentFactor = opts.emptyDates?.has(date) ? WEIGHTS.CONTENT_EMPTY : 1

  const w = ageFactor * recencyPenalty * seasonFactor * contentFactor
  return w > 0 ? w : Number.MIN_VALUE
}

/**
 * Orders candidates by weighted sampling without replacement (Efraimidis–Spirakis):
 * each candidate gets key = -ln(U) / weight, sorted ascending. The result is a full
 * permutation of `candidates` (no entry dropped), with higher-weighted dates tending
 * to appear earlier. `rng` is injectable for deterministic tests.
 */
export function weightedOrder(
  candidates: string[],
  opts: WeightOpts & { rng?: () => number },
): string[] {
  const rng = opts.rng ?? Math.random
  return candidates
    .map(date => {
      const w = serendipityWeight(date, opts)
      // Guard against u === 0 producing Infinity.
      const u = Math.max(rng(), Number.MIN_VALUE)
      return { date, key: -Math.log(u) / w }
    })
    .sort((a, b) => a.key - b.key)
    .map(x => x.date)
}
