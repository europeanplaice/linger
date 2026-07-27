import type { Env, SessionData } from './session'
import { getValidIdToken, saveSession } from './session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile, listEntries, getEntryContent, getDiaryFileMeta, getEntryMeta, findEntryMeta, DriveError } from './drive'
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
// `remaining` is this run's exact target scope minus whatever's been attempted so
// far — the sole source of truth for what a continuation chunk should cover. It's
// tracked explicitly (rather than derived from a Drive listing position/count) so
// entries added or removed mid-run can't shift a positional cursor and silently
// skip a date — see backfillAllEntries. Absent on records written before this field
// existed; api/s3/backfill-continue.ts treats that as unsafe to resume by position.
export interface BackfillProgress {
  total: number
  done: number
  failed: string[]
  remaining?: string[]
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

// Looks up s3_settings.json's fileId via Drive and caches it on the session (like
// ensureFolder does for folder_id) — never the settings *content*, only the file's
// location. A stale fileId is harmlessly self-correcting (readJsonFile 404s and the
// caller re-looks-up), whereas a stale *content* cache (bucket/roleArn/enabled) would
// risk mirroring diary content to a bucket the user just disabled or changed elsewhere
// — see the comment on SessionData.s3_settings_file_id.
async function findAndCacheSettingsFileId(token: string, sessionId: string, session: SessionData, env: Env, folderId: string): Promise<string | null> {
  const fileId = await findJsonFile(token, folderId, S3_SETTINGS_FILE_NAME)
  if (fileId) {
    session.s3_settings_file_id = fileId
    try {
      await saveSession(sessionId, session, env)
    } catch (e) {
      // Caching is a pure optimization — a failure to persist it must not fail the caller.
      console.error('s3Settings.ts: failed to persist settings fileId cache', e)
    }
  }
  return fileId
}

// True if a cached fileId still points to a live (non-trashed) file. Only needed for
// the cached path below — a freshly-found fileId is already guaranteed live, since
// findAndCacheSettingsFileId's own lookup query filters trashed=false. Trashing
// s3_settings.json via Drive's own UI is the ordinary way to delete a file there (a
// soft delete, unlike files.delete), and — unlike a hard delete — a trashed file's
// content still reads fine via alt=media instead of 404ing, so an unchecked cache
// would keep resolving to the old config (and mirroring diary content to whatever
// bucket/role it named) indefinitely after the user believed they'd disabled it.
async function isFileLive(token: string, fileId: string): Promise<boolean> {
  try {
    const meta = await getEntryMeta(token, fileId)
    return meta.trashed !== true
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return false
    throw e
  }
}

async function loadS3SettingsRecord(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3SettingsRecord | null> {
  if (isNegativelyCached(session)) return null

  const folderId = await ensureFolder(token, sessionId, session, env)
  let fileId = session.s3_settings_file_id
  if (fileId && !(await isFileLive(token, fileId))) {
    session.s3_settings_file_id = undefined
    fileId = undefined
  }
  fileId ??= await findAndCacheSettingsFileId(token, sessionId, session, env, folderId)
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
    if (e instanceof DriveError && e.status === 404) {
      // Cached fileId is stale (e.g. the user deleted s3_settings.json in Drive and
      // settings.ts re-created it under a new id) — clear it and look up fresh once.
      session.s3_settings_file_id = undefined
      fileId = await findAndCacheSettingsFileId(token, sessionId, session, env, folderId)
      if (!fileId) {
        session.s3_settings_negative_cache_at = Date.now()
        try {
          await saveSession(sessionId, session, env)
        } catch (e2) {
          console.error('s3Settings.ts: failed to persist negative cache', e2)
        }
        return null
      }
      try {
        data = await readJsonFile<unknown>(token, fileId)
      } catch (e2) {
        if (e2 instanceof SyntaxError) return null
        throw e2
      }
    } else if (e instanceof SyntaxError) {
      return null
    } else {
      throw e
    }
  }
  return isValidS3Settings(data) ? { settings: data, folderId, fileId } : null
}

export async function getS3Settings(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3Settings | null> {
  const record = await loadS3SettingsRecord(token, sessionId, session, env)
  return record?.settings ?? null
}

// Cache key for assumeRoleWithWebIdentity's opportunistic cross-request credential
// cache (see s3.ts) — unique per Google account so cached credentials can never be
// handed out across accounts. Omitted (no caching, just no optimization) when the
// session has no decoded google_sub, e.g. an older session predating that field.
export function credentialsCacheKey(session: SessionData, settings: Pick<S3Settings, 'roleArn' | 'region'>): string | undefined {
  return session.google_sub ? `${session.google_sub}:${settings.roleArn}:${settings.region}` : undefined
}

export function entryKey(date: string): string {
  return `diary-${date}.txt`
}

// s3_settings.json has several concurrent writers (this device's own mirror/backfill
// status updates, another device's, and the user's own Save overwriting config fields
// via settings.ts's PUT) with no optimistic-concurrency check on the Drive file itself.
// Rather than build full conflict detection around that (unverified whether Drive even
// honors If-Match on this endpoint — see saveEntry's ifMatch, which no caller actually
// uses), sync-status writers re-read the file immediately before writing and apply
// `mutate` to that fresh copy instead of a `record.settings` snapshot that may be
// minutes stale — so a concurrent config change (e.g. the user disabling backup mid-
// backfill) never gets silently overwritten back to its old value. Falls back to the
// in-memory snapshot if the fresh read itself fails, same as every other best-effort
// step in this file. Keeps `record.settings` current so later calls in the same run
// (e.g. the next chunk's writeBackfillProgress) start from what was actually written.
async function withFreshS3Settings(
  token: string, record: S3SettingsRecord, mutate: (current: S3Settings) => S3Settings,
): Promise<void> {
  let base = record.settings
  try {
    const fresh = await readJsonFile<unknown>(token, record.fileId)
    if (isValidS3Settings(fresh)) base = fresh
  } catch (e) {
    console.error('s3Settings.ts: fresh re-read before sync-status update failed, using in-memory snapshot', e)
  }
  const updated = mutate(base)
  try {
    await writeJsonFile(token, record.folderId, S3_SETTINGS_FILE_NAME, updated, record.fileId)
    record.settings = updated
  } catch (e) {
    console.error('s3Settings.ts: failed to write sync-status update', e)
  }
}

async function recordMirrorFailure(token: string, record: S3SettingsRecord, message: string): Promise<void> {
  if (record.settings.lastSyncError === message) return // unchanged — avoid a needless Drive write
  await withFreshS3Settings(token, record, current => ({ ...current, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() }))
}

async function recordMirrorSuccess(token: string, record: S3SettingsRecord): Promise<void> {
  if (!record.settings.lastSyncError) return // already clear — nothing to do
  await withFreshS3Settings(token, record, current => {
    const rest = { ...current }
    delete rest.lastSyncError
    delete rest.lastSyncErrorAt
    return rest
  })
}

// True unless Drive gives a definitive "this file is gone" (404). Any other failure
// (network blip, transient Drive error) is treated as "still exists" — an ambiguous
// re-check must never trigger a compensating delete of a legitimate mirror.
async function entryStillExistsInDrive(
  token: string, sessionId: string, session: SessionData, env: Env, fileId: string, date: string,
): Promise<boolean> {
  try {
    await getDiaryFileMeta(token, sessionId, session, env, fileId, date)
    return true
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return false
    console.error('s3Settings.ts: post-mirror existence re-check failed, leaving mirror as-is', e)
    return true
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
  fileId: string,
  driveVersion?: string,
): Promise<void> {
  let record: S3SettingsRecord | null = null
  try {
    record = await loadS3SettingsRecord(accessToken, sessionId, session, env)
    if (!record || !record.settings.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, record.settings.roleArn, record.settings.region, credentialsCacheKey(session, record.settings))
    await putObjectIfNewer(creds, record.settings.bucket, record.settings.region, entryKey(date), content, driveVersion)

    // mirrorEntrySave and mirrorEntryDelete are independent context.waitUntil tasks
    // with no ordering guarantee, so a slower save can land after a faster concurrent
    // delete's mirror already removed this date — resurrecting a deleted entry in the
    // backup. By the time any mirror runs, Drive has already settled to its final state
    // (saveEntry/deleteEntry are awaited before either mirror is even scheduled), so
    // re-checking here and compensating catches every realistic ordering — unlike
    // checking before the put, which only narrows the window.
    const stillExists = await entryStillExistsInDrive(accessToken, sessionId, session, env, fileId, date)
    if (!stillExists) {
      await deleteObject(creds, record.settings.bucket, record.settings.region, entryKey(date))
    }

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

    const creds = await assumeRoleWithWebIdentity(idToken, record.settings.roleArn, record.settings.region, credentialsCacheKey(session, record.settings))
    await deleteObject(creds, record.settings.bucket, record.settings.region, entryKey(date))
    await recordMirrorSuccess(accessToken, record)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntryDelete failed', e)
    if (record) await recordMirrorFailure(accessToken, record, describeError(e))
  }
}

// Additively removes `date` from backfillProgress.failed on a successful
// resyncSingleEntry — the only write resyncSingleEntry is allowed to make to
// backfillProgress. Never touches total/done/remaining/finishedAt: those belong
// exclusively to the chunked run that's actually tracking them (backfillAllEntries,
// driven by settings.ts/resync.ts/backfill-retry.ts/backfill-continue.ts), and a run
// can be genuinely in flight at the same moment a user retries an unrelated single
// entry from its badge. Only a run that's already finished, with nothing else still
// outstanding, is fully cleared here — the same terminal state finishBackfill leaves
// behind when every entry succeeds.
async function clearBackfillFailedDate(token: string, record: S3SettingsRecord, date: string): Promise<void> {
  if (!record.settings.backfillProgress?.failed.includes(date)) return // nothing recorded to clear
  await withFreshS3Settings(token, record, current => {
    const bp = current.backfillProgress
    if (!bp || !bp.failed.includes(date)) return current
    const failed = bp.failed.filter(d => d !== date)
    if (bp.finishedAt && failed.length === 0 && !bp.remaining?.length) {
      const rest = { ...current }
      delete rest.backfillProgress
      delete rest.lastSyncError
      delete rest.lastSyncErrorAt
      return rest
    }
    return { ...current, backfillProgress: { ...bp, failed } }
  })
}

// Re-mirrors exactly one date — the tap-to-retry action on a single entry's sync
// badge (see api/s3/entry-resync/[date].ts), once entry-status has given up waiting
// and reported 'unconfirmed'/'failed'. Deliberately does *not* reuse
// backfillAllEntries: that function's chunk/finish bookkeeping (total/done/remaining/
// finishedAt) belongs to whichever chunked run is actually driving it, and this is
// never one — it's a single ad hoc mirror that can happen at any moment, including
// while a real chunked backfill/resync is mid-flight. Reusing backfillAllEntries here
// previously let a single-date retry stamp finishedAt over — and silently truncate —
// a genuinely in-progress account-wide run. Never throws; failures are recorded via
// recordMirrorFailure same as mirrorEntrySave, and reported back to the caller so the
// HTTP response can reflect them.
export async function resyncSingleEntry(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  settings: S3Settings,
  folderId: string,
  fileId: string,
  date: string,
): Promise<{ ok: boolean; error?: string }> {
  const record: S3SettingsRecord = { settings, folderId, fileId }
  try {
    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region, credentialsCacheKey(session, settings))
    const meta = await findEntryMeta(accessToken, sessionId, session, env, date)
    // No longer exists in Drive (deleted since it was recorded as failed) — nothing
    // to back up, not a failure, same as backfillAllEntries's own handling of a date
    // that disappeared mid-run.
    if (meta) {
      const { content } = await getEntryContent(accessToken, meta.id, date)
      await putObjectIfNewer(creds, settings.bucket, settings.region, entryKey(date), content, meta.version)
    }
    await clearBackfillFailedDate(accessToken, record, date)
    await recordMirrorSuccess(accessToken, record)
    return { ok: true }
  } catch (e) {
    console.error('s3Settings.ts: resyncSingleEntry failed', e)
    const message = describeError(e)
    await recordMirrorFailure(accessToken, record, message)
    return { ok: false, error: message }
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
  await withFreshS3Settings(token, record, current => ({ ...current, backfillProgress: progress }))
}

export async function finishBackfill(token: string, record: S3SettingsRecord, total: number, failed: string[], runLabel: string): Promise<void> {
  const finishedAt = new Date().toISOString()
  await withFreshS3Settings(token, record, current => {
    if (failed.length === 0) {
      const rest = { ...current }
      delete rest.backfillProgress
      delete rest.lastSyncError
      delete rest.lastSyncErrorAt
      return rest
    }
    return {
      ...current,
      backfillProgress: { total, done: total, failed, finishedAt },
      lastSyncError: `${runLabel}: ${failed.length} of ${total} entr${failed.length === 1 ? 'y' : 'ies'} failed to back up`,
      lastSyncErrorAt: finishedAt,
    }
  })
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

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region, credentialsCacheKey(session, settings))
    // Looked up by date (never by array position) below, so an entry added or removed
    // elsewhere in the account between chunks can't shift which dates this chunk covers.
    const driveByDate = new Map(
      (await listEntries(accessToken, sessionId, session, env))
        .map(meta => ({ meta, date: meta.name.match(DIARY_FILENAME_RE)?.[1] }))
        .filter((e): e is { meta: typeof e.meta; date: string } => !!e.date)
        .map(e => [e.date, e.meta] as const),
    )

    // Carry over cumulative progress from prior chunks so total/done are accurate
    // across multiple invocations. When onlyDates is unset (full resync / initial
    // backfill) we always start from zero — the caller wants to re-check every
    // entry, so carrying over a stale `done` from a previous run would let the
    // counter race ahead of the actual work and cause finishBackfill to fire
    // prematurely (or a later parallel chunk to overwrite a higher done with a
    // lower value, making the progress bar jump backwards).
    const existingProgress = settings.backfillProgress
    const freshStart = !onlyDates
    // `scope` is this run's exact target date list, established once (a fresh run's
    // scope is every diary date that currently exists; a scoped/continuing run's
    // scope is exactly what the caller passed — backfill-continue.ts passes
    // `backfillProgress.remaining` verbatim, retry.ts/migrate.ts their own explicit
    // target list) and never re-derived from a re-listed Drive folder's order/count.
    const scope = freshStart ? [...driveByDate.keys()] : onlyDates
    const totalAll = freshStart ? scope.length : (existingProgress?.total ?? scope.length)
    const baseDone = freshStart ? 0 : (existingProgress?.done ?? 0)
    const existingFailed = freshStart ? [] : (existingProgress?.failed ?? [])

    const chunkTargets = chunkSize ? scope.slice(0, chunkSize) : scope
    const newRemaining = chunkSize ? scope.slice(chunkSize) : []

    const failed: string[] = [...existingFailed]
    let done = baseDone
    let lastProgressWriteAt = 0
    for (const [i, date] of chunkTargets.entries()) {
      const meta = driveByDate.get(date)
      if (meta) {
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
      } else {
        // No longer exists in Drive (deleted mid-run, or gone before this run even
        // started) — nothing to back up. Not a failure, just no longer outstanding.
        const failedIdx = failed.indexOf(date)
        if (failedIdx !== -1) failed.splice(failedIdx, 1)
      }
      done += 1
      const now = Date.now()
      const isLastInChunk = i === chunkTargets.length - 1
      if (now - lastProgressWriteAt >= BACKFILL_PROGRESS_WRITE_INTERVAL_MS || isLastInChunk) {
        lastProgressWriteAt = now
        await writeBackfillProgress(accessToken, record, { total: totalAll, done, failed: [...failed], remaining: [...newRemaining] })
      }
    }
    // Only finalise once this run's whole scope has been attempted across all chunks.
    if (newRemaining.length === 0) {
      await finishBackfill(accessToken, record, totalAll, failed, runLabel)
    }
  } catch (e) {
    console.error('s3Settings.ts: backfillAllEntries failed', e)
    await recordMirrorFailure(accessToken, record, `${runLabel} failed: ${describeError(e)}`)
  }
}
