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

// Progress of the one-time initial backfill (or a subsequent retry of just its
// failed entries — see backfillAllEntries's `onlyDates` param). `failed` holds
// the dates that errored on this run; `finishedAt` is absent while still running.
export interface BackfillProgress {
  total: number
  done: number
  failed: string[]
  finishedAt?: string // ISO timestamp
}

export interface S3Settings {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
  lastSyncError?: string
  lastSyncErrorAt?: string // ISO timestamp
  backfillProgress?: BackfillProgress
}

export function isValidS3Settings(body: unknown): body is S3Settings {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.enabled === 'boolean'
    && typeof b.roleArn === 'string' && S3_ROLE_ARN_RE.test(b.roleArn)
    && typeof b.bucket === 'string' && S3_BUCKET_RE.test(b.bucket)
    && typeof b.region === 'string' && S3_REGION_RE.test(b.region)
}

export interface S3SettingsRecord {
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

export function entryKey(date: string): string {
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
export const DIARY_FILENAME_RE = /^diary-(\d{4}-\d{2}-\d{2})\.txt$/

// How often (at most) backfill progress is written back to Drive while running — writing
// on every single entry would multiply Drive API calls for large diaries; this keeps the
// UI's polling reasonably fresh without that cost. The final state is always written
// regardless of this throttle.
const BACKFILL_PROGRESS_WRITE_INTERVAL_MS = 2000

export async function writeBackfillProgress(token: string, record: S3SettingsRecord, progress: BackfillProgress): Promise<void> {
  const updated: S3Settings = { ...record.settings, backfillProgress: progress }
  try {
    await writeJsonFile(token, record.folderId, S3_SETTINGS_FILE_NAME, updated, record.fileId)
    record.settings = updated
  } catch (e) {
    // Progress reporting is a pure UX nicety — a failure to persist it must not abort the backfill itself.
    console.error('s3Settings.ts: failed to persist backfill progress', e)
  }
}

export async function finishBackfill(token: string, record: S3SettingsRecord, total: number, failed: string[], runLabel: string): Promise<void> {
  const finishedAt = new Date().toISOString()
  const updated: S3Settings = { ...record.settings }
  if (failed.length === 0) {
    delete updated.backfillProgress
    delete updated.lastSyncError
    delete updated.lastSyncErrorAt
  } else {
    updated.backfillProgress = { total, done: total, failed, finishedAt }
    updated.lastSyncError = `${runLabel}: ${failed.length} of ${total} entr${failed.length === 1 ? 'y' : 'ies'} failed to back up`
    updated.lastSyncErrorAt = finishedAt
  }
  try {
    await writeJsonFile(token, record.folderId, S3_SETTINGS_FILE_NAME, updated, record.fileId)
  } catch (e) {
    console.error('s3Settings.ts: failed to record backfill completion', e)
  }
}

// Mirrors existing entries to S3: the first time backup is enabled (without this, only
// entries saved/deleted after enabling would ever reach the bucket, silently leaving prior
// history un-backed-up despite the feature being labeled a "backup"); a retry of just the
// entries a previous run failed on, when `onlyDates` is given (see api/s3/backfill-retry.ts);
// or a full resync of every entry regardless of prior failures (api/s3/resync.ts) — safe to
// run any time since putObjectIfNewer no-ops anything already at least as new as Drive.
// `runLabel` only affects the wording of any recorded lastSyncError/backfillProgress message.
// Never throws. A per-entry failure (transient network/S3/Drive hiccup) is recorded and
// skipped rather than aborting the rest of the run; progress and the resulting failed-dates
// list are persisted so the UI can show and retry them.
//
// `chunkSize` limits how many entries are processed per invocation. Cloudflare Pages
// Functions have a wall-clock timeout, so processing hundreds of entries sequentially
// in a single waitUntil call would be killed mid-backfill. The caller (typically
// backfill-continue.ts) passes only the remaining dates via `onlyDates` and a modest
// `chunkSize` so each invocation completes well within the timeout. Progress is
// cumulative across chunks (total/done carry over from prior runs).
export async function backfillAllEntries(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  settings: S3Settings,
  folderId: string,
  fileId: string,
  onlyDates?: string[],
  runLabel = 'Initial backfill',
  chunkSize?: number,
): Promise<void> {
  const record: S3SettingsRecord = { settings, folderId, fileId }
  try {
    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
    const wanted = onlyDates ? new Set(onlyDates) : null
    const allEntries = (await listEntries(accessToken, sessionId, session, env))
      .map(meta => ({ meta, date: meta.name.match(DIARY_FILENAME_RE)?.[1] }))
      .filter((e): e is { meta: typeof e.meta; date: string } => !!e.date && (!wanted || wanted.has(e.date)))

    const entries = chunkSize ? allEntries.slice(0, chunkSize) : allEntries

    // Carry over cumulative progress from prior chunks so total/done are accurate
    // across multiple invocations.
    const existingProgress = settings.backfillProgress
    const totalAll = existingProgress?.total ?? allEntries.length
    const baseDone = existingProgress?.done ?? 0
    const existingFailed = existingProgress?.failed ?? []

    const failed: string[] = [...existingFailed]
    let done = baseDone
    let lastProgressWriteAt = 0
    for (const { meta, date } of entries) {
      try {
        const { content } = await getEntryContent(accessToken, meta.id, date)
        await putObjectIfNewer(creds, settings.bucket, settings.region, entryKey(date), content, meta.version)
        // A previously-failed entry that now succeeded — remove from the failed list.
        const failedIdx = failed.indexOf(date)
        if (failedIdx !== -1) failed.splice(failedIdx, 1)
      } catch (e) {
        console.error(`s3Settings.ts: backfill failed for ${date}`, e)
        if (!failed.includes(date)) failed.push(date)
      }
      done += 1
      const now = Date.now()
      const isLastInChunk = chunkSize ? (done - baseDone) >= chunkSize : false
      const isLastOverall = done >= totalAll
      if (now - lastProgressWriteAt >= BACKFILL_PROGRESS_WRITE_INTERVAL_MS || isLastInChunk || isLastOverall) {
        lastProgressWriteAt = now
        await writeBackfillProgress(accessToken, record, { total: totalAll, done, failed: [...failed] })
      }
    }
    // Only finalise when every entry has been processed across all chunks.
    if (done >= totalAll) {
      await finishBackfill(accessToken, record, totalAll, failed, runLabel)
    }
  } catch (e) {
    console.error('s3Settings.ts: backfillAllEntries failed', e)
    await recordMirrorFailure(accessToken, record, `${runLabel} failed: ${describeError(e)}`)
  }
}
