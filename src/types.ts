export interface DiaryEntry {
  date: string        // "YYYY-MM-DD"
  content: string
  updated_at: string  // ISO 8601
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
