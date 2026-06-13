export interface DiaryEntry {
  date: string        // "YYYY-MM-DD"
  content: string
}

export interface DriveFileMeta {
  id: string
  name: string
  modifiedTime?: string
  version?: string
  trashed?: boolean
}

export interface DriveChange {
  fileId: string
  removed: boolean
  file?: DriveFileMeta
}

export interface ChangesResult {
  changes: DriveChange[]
  newStartPageToken: string
}

export interface LoadedDiaryEntry {
  entry: DiaryEntry
  meta: DriveFileMeta
}

export interface DriveRevisionMeta {
  id: string
  modifiedTime: string
  size?: string
}

export interface Anniversary {
  id: string
  label: string
  date: string   // YYYY-MM-DD
  showBadge?: boolean
  emoji?: string       // custom emoji, default 🎀
  recurring?: boolean  // true = yearly (shows Nth year), false/undefined = one-time
}

export const MAX_ANNIVERSARIES = 10
export const MAX_ANNIVERSARY_BADGES = 3
export const MAX_ANNIVERSARY_LABEL_LENGTH = 100

function hasValidAnniversaryFields(v: unknown): v is {
  id: string
  label: string
  showBadge?: boolean
  emoji?: string
  recurring?: boolean
} {
  const a = v as Anniversary
  return typeof v === 'object' && v !== null
    && typeof a.id === 'string'
    && typeof a.label === 'string'
    && (a.showBadge === undefined || typeof a.showBadge === 'boolean')
    && (a.emoji === undefined || typeof a.emoji === 'string')
    && (a.recurring === undefined || typeof a.recurring === 'boolean')
}

function isValidAnniversaryDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day
}

export function isAnniversary(v: unknown): v is Anniversary {
  return hasValidAnniversaryFields(v)
    && isValidAnniversaryDate((v as { date?: unknown }).date)
}

export function normalizeAnniversary(v: unknown): Anniversary | null {
  if (!hasValidAnniversaryFields(v)) return null
  const candidate = v as {
    id: string
    label: string
    date?: unknown
    monthDay?: unknown
    showBadge?: boolean
    emoji?: string
    recurring?: boolean
  }
  if (isValidAnniversaryDate(candidate.date)) {
    return {
      id: candidate.id,
      label: candidate.label,
      date: candidate.date,
      ...(candidate.showBadge === undefined ? {} : { showBadge: candidate.showBadge }),
      ...(candidate.emoji === undefined ? {} : { emoji: candidate.emoji }),
      ...(candidate.recurring === undefined ? {} : { recurring: candidate.recurring }),
    }
  }
  if (typeof candidate.monthDay !== 'string' || !/^\d{2}-\d{2}$/.test(candidate.monthDay)) {
    return null
  }
  // Legacy records did not retain a year. Use a leap year so 02-29 remains valid.
  const legacyDate = `2000-${candidate.monthDay}`
  if (!isValidAnniversaryDate(legacyDate)) return null
  return {
    id: candidate.id,
    label: candidate.label,
    date: legacyDate,
    ...(candidate.showBadge === undefined ? {} : { showBadge: candidate.showBadge }),
    ...(candidate.emoji === undefined ? {} : { emoji: candidate.emoji }),
    ...(candidate.recurring === undefined ? {} : { recurring: candidate.recurring }),
  }
}

export function normalizeAnniversaries(v: unknown): Anniversary[] {
  if (!Array.isArray(v)) return []
  const result: Anniversary[] = []
  let enabledBadges = 0

  for (const value of v) {
    if (result.length >= MAX_ANNIVERSARIES) break
    const anniversary = normalizeAnniversary(value)
    if (!anniversary) continue
    if (anniversary.showBadge !== false) {
      if (enabledBadges >= MAX_ANNIVERSARY_BADGES) {
        result.push({ ...anniversary, showBadge: false })
        continue
      }
      enabledBadges += 1
    }
    result.push(anniversary)
  }

  return result
}


export interface AnniversaryProximity {
  id: string
  label: string
  date: string
  distance: number
  emoji?: string
  recurring?: boolean
  nthYear?: number  // computed: how many years since the anniversary date (only for recurring)
}
