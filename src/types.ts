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
  date: string   // YYYY-MM-DD (year stored for reference; proximity uses MM-DD)
  showBadge?: boolean
}

export function isAnniversary(v: unknown): v is Anniversary {
  const a = v as Anniversary
  if (!(typeof v === 'object' && v !== null
    && typeof a.id === 'string'
    && typeof a.label === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(a.date)
    && (a.showBadge === undefined || typeof a.showBadge === 'boolean'))) {
    return false
  }
  const [year, month, day] = a.date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day
}

export function isAnniversaryArray(v: unknown): v is Anniversary[] {
  return Array.isArray(v) && v.every(isAnniversary)
}

export interface AnniversaryProximity {
  id: string
  label: string
  monthDay: string
  distance: number
}
