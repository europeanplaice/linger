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
  monthDay: string
}

export function isAnniversary(v: unknown): v is Anniversary {
  return typeof v === 'object' && v !== null
    && typeof (v as Anniversary).id === 'string'
    && typeof (v as Anniversary).label === 'string'
    && /^\d{2}-\d{2}$/.test((v as Anniversary).monthDay)
}

export function isAnniversaryArray(v: unknown): v is Anniversary[] {
  return Array.isArray(v) && v.every(isAnniversary)
}

export interface AnniversaryProximity {
  label: string
  monthDay: string
  distance: number
}
