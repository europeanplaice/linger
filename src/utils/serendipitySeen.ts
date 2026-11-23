/**
 * Keeps recently surfaced serendipity dates in this tab for the current session,
 * so reopening Looking Back can avoid showing the same day twice in a row.
 */

const MAX = 30

export interface SeenEntry {
  date: string
  ts: number
}

let seen: SeenEntry[] = []

export function loadSeen(): readonly SeenEntry[] { return seen }

/** Records `date` as just-shown (newest first, deduped, capped at MAX). */
export function recordSeen(date: string, now: number = Date.now()): void {
  seen = [{ date, ts: now }, ...seen.filter(entry => entry.date !== date)].slice(0, MAX)
}

export function clearSeen(): void {
  seen = []
  try { localStorage.removeItem('linger_serendipity_seen') }
  catch { /* Unavailable storage must not prevent authentication changes. */ }
}
