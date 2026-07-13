import type { Env, SessionData } from './session'
import { getValidIdToken, saveSession } from './session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile, listEntries, getEntryContent } from './drive'
import { assumeRoleWithWebIdentity, putObjectIfNewer, deleteObject, describeError } from './s3'

export const S3_SETTINGS_FILE_NAME = 's3_settings.json'

export const S3_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/
// No dots: virtual-hosted-style URLs (bucket.s3.region.amazonaws.com) break TLS
// for dotted bucket names since AWS's wildcard cert only covers one label.
export const S3_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
export const S3_REGION_RE = /^[a-z]{2}-[a-z]+-\d$/

// How long a confirmed "no s3_settings.json" result is trusted before re-checking Drive.
// Bounds how stale a second device's view of "S3 backup just got enabled elsewhere" can be,
// while saving a Drive files.list call on nearly every save/delete for Drive-only users.
export const S3_SETTINGS_NEGATIVE_CACHE_MS = 5 * 60 * 1000

export interface S3Settings {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
  lastSyncError?: string
  lastSyncErrorAt?: string // ISO timestamp
}

export function isValidS3Settings(body: unknown): body is S3Settings {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.enabled === 'boolean'
    && typeof b.roleArn === 'string' && S3_ROLE_ARN_RE.test(b.roleArn)
    && typeof b.bucket === 'string' && S3_BUCKET_RE.test(b.bucket)
    && typeof b.region === 'string' && S3_REGION_RE.test(b.region)
}

interface S3SettingsRecord {
  settings: S3Settings
  folderId: string
  fileId: string
}

function isNegativelyCached(session: SessionData): boolean {
  const at = session.s3_settings_negative_cache_at
  return at !== undefined && Date.now() - at < S3_SETTINGS_NEGATIVE_CACHE_MS
}

async function loadS3SettingsRecord(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3SettingsRecord | null> {
  if (isNegativelyCached(session)) return null

  const folderId = await ensureFolder(token, sessionId, session, env)
  const fileId = await findJsonFile(token, folderId, S3_SETTINGS_FILE_NAME)
  if (!fileId) {
    session.s3_settings_negative_cache_at = Date.now()
    try {
      await saveSession(sessionId, session, env)
    } catch (e) {
      // Caching is a pure optimization — a failure to persist it must not fail the caller.
      console.error('s3Settings.ts: failed to persist negative cache', e)
    }
    return null
  }

  let data: unknown
  try {
    data = await readJsonFile<unknown>(token, fileId)
  } catch (e) {
    if (e instanceof SyntaxError) return null
    throw e
  }
  return isValidS3Settings(data) ? { settings: data, folderId, fileId } : null
}

export async function getS3Settings(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3Settings | null> {
  const record = await loadS3SettingsRecord(token, sessionId, session, env)
  return record?.settings ?? null
}

function entryKey(date: string): string {
  return `diary-${date}.txt`
}

async function recordMirrorFailure(token: string, record: S3SettingsRecord, message: string): Promise<void> {
  if (record.settings.lastSyncError === message) return // unchanged — avoid a needless Drive write
  const updated: S3Settings = { ...record.settings, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() }
  try {
    await writeJsonFile(token, record.folderId, S3_SETTINGS_FILE_NAME, updated, record.fileId)
  } catch (e) {
    console.error('s3Settings.ts: failed to record mirror failure', e)
  }
}

async function recordMirrorSuccess(token: string, record: S3SettingsRecord): Promise<void> {
  if (!record.settings.lastSyncError) return // already clear — nothing to do
  const { lastSyncError: _lastSyncError, lastSyncErrorAt: _lastSyncErrorAt, ...rest } = record.settings
  try {
    await writeJsonFile(token, record.folderId, S3_SETTINGS_FILE_NAME, rest, record.fileId)
  } catch (e) {
    console.error('s3Settings.ts: failed to record mirror success', e)
  }
}

// Best-effort mirror to the user's own S3 bucket — never throws. A failure here
// must not turn a successful Drive save (the source of truth) into an error
// response, so every failure mode is caught and recorded on the settings record
// instead of propagated. Callers should invoke this via context.waitUntil so it
// doesn't block the response.
export async function mirrorEntrySave(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  date: string,
  content: string,
  driveVersion?: string,
): Promise<void> {
  let record: S3SettingsRecord | null = null
  try {
    record = await loadS3SettingsRecord(accessToken, sessionId, session, env)
    if (!record || !record.settings.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, record.settings.roleArn, record.settings.region)
    await putObjectIfNewer(creds, record.settings.bucket, record.settings.region, entryKey(date), content, driveVersion)
    await recordMirrorSuccess(accessToken, record)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntrySave failed', e)
    if (record) await recordMirrorFailure(accessToken, record, describeError(e))
  }
}

export async function mirrorEntryDelete(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  date: string,
): Promise<void> {
  let record: S3SettingsRecord | null = null
  try {
    record = await loadS3SettingsRecord(accessToken, sessionId, session, env)
    if (!record || !record.settings.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, record.settings.roleArn, record.settings.region)
    await deleteObject(creds, record.settings.bucket, record.settings.region, entryKey(date))
    await recordMirrorSuccess(accessToken, record)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntryDelete failed', e)
    if (record) await recordMirrorFailure(accessToken, record, describeError(e))
  }
}

// Diary filenames only ever look like diary-YYYY-MM-DD.txt (legacy .md files are migrated
// to .txt long before this can run); anything else in the folder (e.g. s3_settings.json,
// milestones.json) is skipped.
const DIARY_FILENAME_RE = /^diary-(\d{4}-\d{2}-\d{2})\.txt$/

// Mirrors every existing entry to S3 the first time backup is enabled — without this, only
// entries saved/deleted after enabling would ever reach the bucket, silently leaving prior
// history un-backed-up despite the feature being labeled a "backup". Never throws; failures
// are recorded on the settings record the same way mirrorEntrySave/mirrorEntryDelete do.
export async function backfillAllEntries(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  settings: S3Settings,
  folderId: string,
  fileId: string,
): Promise<void> {
  const record: S3SettingsRecord = { settings, folderId, fileId }
  try {
    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
    const entries = await listEntries(accessToken, sessionId, session, env)
    for (const meta of entries) {
      const date = meta.name.match(DIARY_FILENAME_RE)?.[1]
      if (!date) continue
      const { content } = await getEntryContent(accessToken, meta.id, date)
      await putObjectIfNewer(creds, settings.bucket, settings.region, entryKey(date), content, meta.version)
    }
    await recordMirrorSuccess(accessToken, record)
  } catch (e) {
    console.error('s3Settings.ts: backfillAllEntries failed', e)
    await recordMirrorFailure(accessToken, record, `Initial backfill failed: ${describeError(e)}`)
  }
}
