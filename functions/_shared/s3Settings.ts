import type { Env, SessionData } from './session'
import { getValidIdToken, saveSession } from './session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile, listEntries, getEntryContent, getDiaryFileMeta, getEntryMeta, findEntryMeta, DriveError } from './drive'
import { assumeRoleWithWebIdentity, putObjectIfNewer, deleteObject, describeError, CREDENTIALS_EXPIRY_MARGIN_MS, type AssumedCredentials } from './s3'

export const S3_SETTINGS_FILE_NAME = 's3_settings.json'
// Sync status (lastSyncError*/backfillProgress) lives in its own file, separate from
// config (enabled/roleArn/bucket/region) in S3_SETTINGS_FILE_NAME. They used to share
// one file, written by very different actors at very different frequencies — the
// user's own rare Settings-form saves, and every background mirror/backfill write —
// with no concurrency control, so one could silently clobber the other (see
// S3SettingsRecord and withFreshS3Status below). Splitting them means a config save
// can never again lose an in-flight backfill's progress, or vice versa.
export const S3_SYNC_STATUS_FILE_NAME = 's3_sync_status.json'

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
  // Stamped fresh on every write (see writeBackfillProgress/finishBackfill) — lets
  // isBackfillRunActive tell a genuinely still-running run from one that was
  // orphaned mid-flight (e.g. the isolate driving it died, or the client that would
  // have kept polling backfill-continue.ts never came back) and would otherwise
  // block every future resync/retry with "already running" forever, since nothing
  // else ever sets finishedAt on an abandoned run. Absent on records written before
  // this field existed — treated as stale, same as any other unwritten value.
  updatedAt?: string // ISO timestamp
}

// How long a backfillProgress with no finishedAt is still trusted to mean "genuinely
// still running" before the resync/retry/migrate guards below treat it as abandoned
// and allow a new run to start. Comfortably longer than one chunk should ever take
// (backfillAllEntries's own chunk size is tuned to finish well within a single
// invocation's timeout — see its chunkSize doc comment) so a run that's actually
// still healthy is never second-guessed, while a truly orphaned one doesn't block
// every future attempt indefinitely.
const STALE_BACKFILL_MS = 10 * 60 * 1000

// Whether `progress` represents a chunked run a new resync/retry/migrate-resync must
// not be started alongside (see backfill-retry.ts's original guard for why: two runs
// sharing this same total/done/remaining/finishedAt bookkeeping race, and whichever
// finishes its own scope first truncates the other). A run with no recent write is
// treated as abandoned rather than active, so an orphaned run can never permanently
// block every future attempt.
export function isBackfillRunActive(progress: BackfillProgress | undefined): boolean {
  if (!progress || progress.finishedAt) return false
  if (!progress.updatedAt) return false
  return Date.now() - Date.parse(progress.updatedAt) < STALE_BACKFILL_MS
}

// The part of S3 backup state the user edits directly via Settings — stored in
// S3_SETTINGS_FILE_NAME, written only by api/s3/settings.ts's PUT handler.
export interface S3Config {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
}

// The part of S3 backup state background sync writes — stored in
// S3_SYNC_STATUS_FILE_NAME, written only via withFreshS3Status below.
export interface S3SyncStatus {
  lastSyncError?: string
  lastSyncErrorAt?: string // ISO timestamp
  // The date this error was recorded for (see recordMirrorFailure) — absent for a
  // run-level failure not tied to one date (e.g. backfillAllEntries's own summary
  // error, or its own top-level catch-all) and for settings written before this
  // field existed. entry-status/[date].ts only attributes a dated error to the
  // exact date it names, so an unrelated date's error can no longer bleed into a
  // different entry's badge.
  lastSyncErrorDate?: string
  backfillProgress?: BackfillProgress
}

// The public shape every API response and frontend consumer has always worked
// with — config and status merged into one object, regardless of how they're
// stored (see S3SettingsRecord). Keeping this combined type means the frontend
// (src/types.ts's S3Settings, useS3Backfill.ts, SettingsModal.tsx) needed no
// changes for the storage split.
export type S3Settings = S3Config & S3SyncStatus

export function isValidS3Settings(body: unknown): body is S3Settings {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.enabled === 'boolean'
    && typeof b.roleArn === 'string' && S3_ROLE_ARN_RE.test(b.roleArn)
    && typeof b.bucket === 'string' && S3_BUCKET_RE.test(b.bucket)
    && typeof b.region === 'string' && S3_REGION_RE.test(b.region)
}

// Sync status has no required fields (a freshly-created or never-written status
// file is legitimately `{}`) — anything object-shaped is accepted, same
// permissiveness isValidS3Settings already affords status fields tagging along.
function isValidS3SyncStatus(body: unknown): body is S3SyncStatus {
  return !!body && typeof body === 'object'
}

// config/status plus enough Drive bookkeeping (folderId, each file's id) for
// callers to write back to either file. `statusFileId` is null until the first
// sync-status write ever happens for this account — withFreshS3Status creates it
// on demand.
export interface S3SettingsRecord {
  config: S3Config
  status: S3SyncStatus
  folderId: string
  configFileId: string
  statusFileId: string | null
}

function isNegativelyCached(session: SessionData): boolean {
  const at = session.s3_settings_negative_cache_at
  return at !== undefined && Date.now() - at < S3_SETTINGS_NEGATIVE_CACHE_MS
}

function isStatusNegativelyCached(session: SessionData): boolean {
  const at = session.s3_status_negative_cache_at
  return at !== undefined && Date.now() - at < S3_SETTINGS_NEGATIVE_CACHE_MS
}

// True if a cached fileId still points to a live (non-trashed) file. A freshly-found
// fileId is already guaranteed live, since findJsonFile's own lookup query filters
// trashed=false — this is only needed for a fileId trusted from the session cache.
// Trashing a file via Drive's own UI is the ordinary way to delete it there (a soft
// delete, unlike files.delete), and — unlike a hard delete — a trashed file's content
// still reads fine via alt=media instead of 404ing, so an unchecked cache would keep
// resolving to stale content indefinitely after the user believed they'd deleted it.
async function isFileLive(token: string, fileId: string): Promise<boolean> {
  try {
    const meta = await getEntryMeta(token, fileId)
    return meta.trashed !== true
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return false
    throw e
  }
}

// Resolves fileName's parsed content + fileId within folderId, using `cachedFileId`
// as a hint (validated live before trusting it) and re-finding once if it's stale,
// missing, or 404s on read. Never throws for a missing/corrupt/invalid file — that's
// treated the same as "doesn't exist yet", since both config and status are
// best-effort-recoverable (a corrupt config is reported as "not configured"; a
// corrupt status file just starts fresh).
async function resolveDriveJson<T>(
  token: string, folderId: string, fileName: string, cachedFileId: string | undefined,
  isValid: (v: unknown) => v is T,
): Promise<{ value: T | null; fileId: string | null }> {
  let fileId = cachedFileId
  if (fileId && !(await isFileLive(token, fileId))) fileId = undefined
  fileId ??= (await findJsonFile(token, folderId, fileName)) ?? undefined
  if (!fileId) return { value: null, fileId: null }

  const read = async (id: string): Promise<T | null> => {
    try {
      const data = await readJsonFile<unknown>(token, id)
      return isValid(data) ? data : null
    } catch (e) {
      if (e instanceof SyntaxError) return null
      throw e
    }
  }

  try {
    return { value: await read(fileId), fileId }
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      // Cached fileId was stale (e.g. the file was deleted and later re-created under
      // a new id) — look up fresh once.
      const refound = (await findJsonFile(token, folderId, fileName)) ?? undefined
      if (!refound) return { value: null, fileId: null }
      return { value: await read(refound), fileId: refound }
    }
    throw e
  }
}

// Loads the config file (required — absence means S3 backup isn't configured at all,
// same as before the split) and the status file (optional — absence just means no
// sync activity has happened yet). Caches both files' ids on the session like
// folder_id, and negatively caches a missing config file, so repeated calls (every
// mirror/poll) don't each pay a files.list lookup — see S3_SETTINGS_NEGATIVE_CACHE_MS.
export async function loadS3SettingsRecord(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3SettingsRecord | null> {
  if (isNegativelyCached(session)) return null

  const folderId = await ensureFolder(token, sessionId, session, env)
  let sessionChanged = false

  // Config and status live in two independent Drive files — resolving them
  // concurrently instead of one-after-another saves a full round trip off every
  // mirror/poll. The status fetch is occasionally wasted work on the (uncommon)
  // "S3 backup isn't configured at all" path below, traded for that saving on the
  // common path where config is present.
  const statusNegativelyCached = isStatusNegativelyCached(session)
  const [{ value: configData, fileId: configFileId }, statusResult] = await Promise.all([
    resolveDriveJson(token, folderId, S3_SETTINGS_FILE_NAME, session.s3_settings_file_id, isValidS3Settings),
    statusNegativelyCached
      ? Promise.resolve({ value: null as S3SyncStatus | null, fileId: null as string | null })
      : resolveDriveJson(token, folderId, S3_SYNC_STATUS_FILE_NAME, session.s3_status_file_id, isValidS3SyncStatus),
  ])
  if (session.s3_settings_file_id !== (configFileId ?? undefined)) {
    session.s3_settings_file_id = configFileId ?? undefined
    sessionChanged = true
  }

  if (!configData || !configFileId) {
    session.s3_settings_negative_cache_at = Date.now()
    try {
      await saveSession(sessionId, session, env)
    } catch (e) {
      console.error('s3Settings.ts: failed to persist negative cache', e)
    }
    return null
  }

  // Note: withFreshS3Status (below) can create the status file for the first time
  // without going through this function again, so this session's negative cache can
  // stay stale for up to S3_SETTINGS_NEGATIVE_CACHE_MS after that happens — e.g. a
  // just-recorded error might not get picked up by the very next recordMirrorSuccess
  // dedup check on this same session. Self-heals once the cache expires; same
  // accepted staleness bound as the config negative cache above.
  const { value: statusData, fileId: statusFileId } = statusResult
  if (!statusNegativelyCached) {
    if (!statusFileId && session.s3_status_negative_cache_at === undefined) {
      session.s3_status_negative_cache_at = Date.now()
      sessionChanged = true
    } else if (statusFileId && session.s3_status_negative_cache_at !== undefined) {
      session.s3_status_negative_cache_at = undefined
      sessionChanged = true
    }
  }
  if (session.s3_status_file_id !== (statusFileId ?? undefined)) {
    session.s3_status_file_id = statusFileId ?? undefined
    sessionChanged = true
  }

  if (sessionChanged) {
    try {
      await saveSession(sessionId, session, env)
    } catch (e) {
      console.error('s3Settings.ts: failed to persist settings/status fileId cache', e)
    }
  }

  return {
    config: { enabled: configData.enabled, roleArn: configData.roleArn, bucket: configData.bucket, region: configData.region },
    status: statusData ?? {},
    folderId,
    configFileId,
    statusFileId,
  }
}

export async function getS3Settings(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3Settings | null> {
  const record = await loadS3SettingsRecord(token, sessionId, session, env)
  return record ? { ...record.config, ...record.status } : null
}

// Cache key for assumeRoleWithWebIdentity's opportunistic cross-request credential
// cache (see s3.ts) — unique per Google account so cached credentials can never be
// handed out across accounts. Omitted (no caching, just no optimization) when the
// session has no decoded google_sub, e.g. an older session predating that field.
export function credentialsCacheKey(session: SessionData, config: Pick<S3Config, 'roleArn' | 'region'>): string | undefined {
  return session.google_sub ? `${session.google_sub}:${config.roleArn}:${config.region}` : undefined
}

// Wraps assumeRoleWithWebIdentity with a cache in the user's own durable KV session
// record (session.s3_assumed_credentials), on top of s3.ts's own in-isolate Map cache.
// The in-isolate cache rarely helps here: a low-traffic personal account's requests
// tend to land on cold isolates, so nearly every save and every entry-status poll (up
// to 7 per save, see EntryEditor.tsx's S3_POLL_DELAYS_MS) was paying a full STS
// round trip. The session is already loaded into memory by the request middleware
// before this ever runs, so a cache hit here costs nothing — not even a KV read.
export async function getAssumedCredentials(
  idToken: string, sessionId: string, session: SessionData, env: Env, config: Pick<S3Config, 'roleArn' | 'region'>,
): Promise<AssumedCredentials> {
  const cacheKey = credentialsCacheKey(session, config)
  const cached = session.s3_assumed_credentials
  if (cached && cacheKey && cached.cacheKey === cacheKey && cached.expiresAt - CREDENTIALS_EXPIRY_MARGIN_MS > Date.now()) {
    return cached
  }

  const creds = await assumeRoleWithWebIdentity(idToken, config.roleArn, config.region, cacheKey)
  if (cacheKey) {
    session.s3_assumed_credentials = { ...creds, cacheKey }
    try {
      await saveSession(sessionId, session, env)
    } catch (e) {
      console.error('s3Settings.ts: failed to persist assumed-credentials cache', e)
    }
  }
  return creds
}

export function entryKey(date: string): string {
  return `diary-${date}.txt`
}

// How many times a sync-status write retries onto a fresh copy after detecting a
// concurrent writer, before giving up (best-effort, same as every other failure mode
// in this file — a lost status update is cosmetic, self-healing on the next mirror).
const S3_STATUS_WRITE_MAX_ATTEMPTS = 3

// Every background sync-status writer (mirrorEntrySave/mirrorEntryDelete/
// resyncSingleEntry/backfillAllEntries, via recordMirrorFailure/recordMirrorSuccess/
// clearBackfillFailedDate/writeBackfillProgress/finishBackfill) funnels through here
// to update S3_SYNC_STATUS_FILE_NAME. Splitting status into its own file already
// keeps this from colliding with the user's own config saves; this closes the
// remaining race *among concurrent status writers themselves* (e.g. two devices
// mirroring different dates at once, or a backfill chunk racing a single-entry
// retry) with a real optimistic-concurrency check instead of the old "re-read
// right before writing" heuristic, which only narrowed the window rather than
// closing it: Drive's `version` is a monotonic per-file counter, so if our write
// doesn't land as exactly fresh+1, some other write slipped in between our read and
// ours — we re-read onto its result and retry the mutate, rather than silently
// clobbering it. `record.statusFileId` starts null until the first status write
// ever happens for this account, at which point it's created and cached.
async function withFreshS3Status(
  token: string, record: S3SettingsRecord, mutate: (current: S3SyncStatus) => S3SyncStatus,
): Promise<void> {
  for (let attempt = 0; attempt < S3_STATUS_WRITE_MAX_ATTEMPTS; attempt++) {
    let base: S3SyncStatus = record.status
    let baseVersion: string | undefined
    if (record.statusFileId) {
      try {
        const [content, meta] = await Promise.all([
          readJsonFile<unknown>(token, record.statusFileId),
          getEntryMeta(token, record.statusFileId),
        ])
        if (isValidS3SyncStatus(content)) base = content
        baseVersion = meta.version
      } catch (e) {
        console.error('s3Settings.ts: fresh re-read before sync-status update failed, using in-memory snapshot', e)
      }
    }

    const updated = mutate(base)
    try {
      const meta = await writeJsonFile(token, record.folderId, S3_SYNC_STATUS_FILE_NAME, updated, record.statusFileId ?? undefined)
      record.statusFileId = meta.id
      record.status = updated
      // No prior version to compare against (brand-new file, or the fresh re-read
      // above failed) — nothing to detect a conflict against, so trust the write.
      // Otherwise: landing exactly one version past what we read means nothing raced
      // us. Anything else means a concurrent writer's update landed in between ours
      // — retry onto its result instead of leaving it silently overwritten.
      if (baseVersion === undefined || meta.version === undefined || Number(meta.version) === Number(baseVersion) + 1) {
        return
      }
    } catch (e) {
      console.error('s3Settings.ts: failed to write sync-status update', e)
      return
    }
  }
  console.error('s3Settings.ts: gave up on sync-status update after repeated concurrent writes')
}

// `date` is the specific date this failure occurred for, when there is one
// (mirrorEntrySave/mirrorEntryDelete/resyncSingleEntry all operate on exactly one
// date); absent for a run-level failure not tied to any single date
// (backfillAllEntries's own top-level catch-all). Compares both date *and*
// message for the dedup check — comparing message alone would let an identical
// error recurring for a *different* date silently keep lastSyncErrorDate
// pointing at the first, stale date instead of updating it.
async function recordMirrorFailure(token: string, record: S3SettingsRecord, message: string, date?: string): Promise<void> {
  if (record.status.lastSyncError === message && record.status.lastSyncErrorDate === date) return
  await withFreshS3Status(token, record, current => {
    const updated = { ...current, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() }
    if (date === undefined) delete updated.lastSyncErrorDate
    else updated.lastSyncErrorDate = date
    return updated
  })
}

// Only clears an error recorded for a *different* date — a success for date A
// must never launder away date B's still-unresolved failure. A dateless error
// (a run-level failure, or settings predating lastSyncErrorDate) is cleared by
// any success, same as before this field existed.
async function recordMirrorSuccess(token: string, record: S3SettingsRecord, date?: string): Promise<void> {
  if (!record.status.lastSyncError) return // already clear — nothing to do
  if (record.status.lastSyncErrorDate !== undefined && record.status.lastSyncErrorDate !== date) return
  await withFreshS3Status(token, record, current => {
    const rest = { ...current }
    delete rest.lastSyncError
    delete rest.lastSyncErrorAt
    delete rest.lastSyncErrorDate
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
    if (!record || !record.config.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await getAssumedCredentials(idToken, sessionId, session, env, record.config)
    await putObjectIfNewer(creds, record.config.bucket, record.config.region, entryKey(date), content, driveVersion)

    // mirrorEntrySave and mirrorEntryDelete are independent context.waitUntil tasks
    // with no ordering guarantee, so a slower save can land after a faster concurrent
    // delete's mirror already removed this date — resurrecting a deleted entry in the
    // backup. By the time any mirror runs, Drive has already settled to its final state
    // (saveEntry/deleteEntry are awaited before either mirror is even scheduled), so
    // re-checking here and compensating catches every realistic ordering — unlike
    // checking before the put, which only narrows the window.
    const stillExists = await entryStillExistsInDrive(accessToken, sessionId, session, env, fileId, date)
    if (!stillExists) {
      await deleteObject(creds, record.config.bucket, record.config.region, entryKey(date))
    }

    await recordMirrorSuccess(accessToken, record, date)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntrySave failed', e)
    if (record) await recordMirrorFailure(accessToken, record, describeError(e), date)
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
    if (!record || !record.config.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await getAssumedCredentials(idToken, sessionId, session, env, record.config)
    await deleteObject(creds, record.config.bucket, record.config.region, entryKey(date))
    await recordMirrorSuccess(accessToken, record, date)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntryDelete failed', e)
    if (record) await recordMirrorFailure(accessToken, record, describeError(e), date)
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
  if (!record.status.backfillProgress?.failed.includes(date)) return // nothing recorded to clear
  await withFreshS3Status(token, record, current => {
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
  record: S3SettingsRecord,
  date: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await getAssumedCredentials(idToken, sessionId, session, env, record.config)
    const meta = await findEntryMeta(accessToken, sessionId, session, env, date)
    // No longer exists in Drive (deleted since it was recorded as failed) — nothing
    // to back up, not a failure, same as backfillAllEntries's own handling of a date
    // that disappeared mid-run.
    if (meta) {
      const { content } = await getEntryContent(accessToken, meta.id, date)
      await putObjectIfNewer(creds, record.config.bucket, record.config.region, entryKey(date), content, meta.version)
    }
    await clearBackfillFailedDate(accessToken, record, date)
    await recordMirrorSuccess(accessToken, record, date)
    return { ok: true }
  } catch (e) {
    console.error('s3Settings.ts: resyncSingleEntry failed', e)
    const message = describeError(e)
    await recordMirrorFailure(accessToken, record, message, date)
    return { ok: false, error: message }
  }
}

// Diary filenames only ever look like diary-YYYY-MM-DD.txt (legacy .md files are migrated
// to .txt long before this can run); anything else in the folder (e.g. s3_settings.json,
// s3_sync_status.json, milestones.json) is skipped.
export const DIARY_FILENAME_RE = /^diary-(\d{4}-\d{2}-\d{2})\.txt$/

// How often (at most) backfill progress is written back to Drive while running — writing
// on every single entry would multiply Drive API calls for large diaries; this keeps the
// UI's polling reasonably fresh without that cost. The final state is always written
// regardless of this throttle.
const BACKFILL_PROGRESS_WRITE_INTERVAL_MS = 2000

export async function writeBackfillProgress(token: string, record: S3SettingsRecord, progress: BackfillProgress): Promise<void> {
  await withFreshS3Status(token, record, current => ({ ...current, backfillProgress: { ...progress, updatedAt: new Date().toISOString() } }))
}

export async function finishBackfill(token: string, record: S3SettingsRecord, total: number, failed: string[], runLabel: string): Promise<void> {
  const finishedAt = new Date().toISOString()
  await withFreshS3Status(token, record, current => {
    if (failed.length === 0) {
      const rest = { ...current }
      delete rest.backfillProgress
      delete rest.lastSyncError
      delete rest.lastSyncErrorAt
      delete rest.lastSyncErrorDate
      return rest
    }
    // This error summarizes potentially many failed dates at once, not any single
    // one — a lastSyncErrorDate left over from an earlier single-entry failure
    // must not survive and get misattributed to just one of them.
    const rest = { ...current }
    delete rest.lastSyncErrorDate
    return {
      ...rest,
      backfillProgress: { total, done: total, failed, finishedAt, updatedAt: finishedAt },
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
  record: S3SettingsRecord,
  onlyDates?: string[],
  runLabel = 'Initial backfill',
  chunkSize?: number,
): Promise<void> {
  try {
    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) throw new Error('No Google ID token in this session — sign out and sign in again')

    const creds = await getAssumedCredentials(idToken, sessionId, session, env, record.config)
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
    const existingProgress = record.status.backfillProgress
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
          await putObjectIfNewer(creds, record.config.bucket, record.config.region, entryKey(date), content, meta.version)
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
