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

export type StorageMode = 'drive' | 'local' | 'fs'

// Self-hosted S3 mirror connection (see self-hosted/aws-s3/). Stored per-user in
// Drive, not in linger's own infra — linger holds no AWS credentials for this.
export interface S3Settings {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
}

export interface DriveRevisionMeta {
  id: string
  modifiedTime: string
  size?: string
}

export interface Milestone {
  id: string
  label: string
  date: string   // YYYY-MM-DD
  showBadge?: boolean
  emoji?: string       // custom emoji, default 🎀
  recurring?: boolean  // false = one-time; true/undefined = yearly (shows Nth year)
}

export const MAX_MILESTONES = 50
export const MAX_MILESTONE_BADGES = 5
export const MAX_MILESTONE_LABEL_LENGTH = 100

function hasValidMilestoneFields(v: unknown): v is {
  id: string
  label: string
  showBadge?: boolean
  emoji?: string
  recurring?: boolean
} {
  const a = v as Milestone
  return typeof v === 'object' && v !== null
    && typeof a.id === 'string'
    && typeof a.label === 'string'
    && (a.showBadge === undefined || typeof a.showBadge === 'boolean')
    && (a.emoji === undefined || typeof a.emoji === 'string')
    && (a.recurring === undefined || typeof a.recurring === 'boolean')
}

function isValidMilestoneDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day
}

export function isMilestone(v: unknown): v is Milestone {
  return hasValidMilestoneFields(v)
    && isValidMilestoneDate((v as { date?: unknown }).date)
}

export function normalizeMilestone(v: unknown): Milestone | null {
  if (!hasValidMilestoneFields(v)) return null
  const candidate = v as {
    id: string
    label: string
    date?: unknown
    monthDay?: unknown
    showBadge?: boolean
    emoji?: string
    recurring?: boolean
  }
  if (isValidMilestoneDate(candidate.date)) {
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
  if (!isValidMilestoneDate(legacyDate)) return null
  return {
    id: candidate.id,
    label: candidate.label,
    date: legacyDate,
    ...(candidate.showBadge === undefined ? {} : { showBadge: candidate.showBadge }),
    ...(candidate.emoji === undefined ? {} : { emoji: candidate.emoji }),
    ...(candidate.recurring === undefined ? {} : { recurring: candidate.recurring }),
  }
}

export function normalizeMilestones(v: unknown): Milestone[] {
  if (!Array.isArray(v)) return []
  const result: Milestone[] = []
  let enabledBadges = 0

  for (const value of v) {
    if (result.length >= MAX_MILESTONES) break
    const milestone = normalizeMilestone(value)
    if (!milestone) continue
    if (milestone.showBadge !== false) {
      if (enabledBadges >= MAX_MILESTONE_BADGES) {
        result.push({ ...milestone, showBadge: false })
        continue
      }
      enabledBadges += 1
    }
    result.push(milestone)
  }

  return result
}


export interface MilestoneProximity {
  id: string
  label: string
  date: string
  distance: number
  emoji?: string
  recurring?: boolean
  nthYear?: number  // computed: how many years since the milestone date (only for recurring)
}
