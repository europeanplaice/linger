/**
 * Persists the dates recently surfaced by the serendipity ("A day, by chance")
 * slot, so reopening Looking Back can avoid showing the same day twice in a row.
 * Only dates are stored — never entry content.
 */

const KEY = 'linger_serendipity_seen'
const MAX = 30

export interface SeenEntry {
  date: string
  ts: number
}

export function loadSeen(): SeenEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is SeenEntry =>
        e != null && typeof e.date === 'string' && typeof e.ts === 'number',
    )
  } catch {
    return []
  }
}

/** Records `date` as just-shown (newest first, deduped, capped at MAX). */
export function recordSeen(date: string, now: number = Date.now()): void {
  try {
    const existing = loadSeen().filter(e => e.date !== date)
    const next = [{ date, ts: now }, ...existing].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Ignore: storage unavailable or quota exceeded — non-essential feature.
  }
}
