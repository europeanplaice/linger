import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { SessionData } from '../../../functions/_shared/session'
import { getSession, getSessionByStorageId, getValidAccessToken, getValidIdToken, invalidateFolderScopedS3Cache } from '../../../functions/_shared/session'
import {
  findEntryMeta,
  findJsonFile,
  getDiaryFileMeta,
  getEntryContent,
  readJsonFile,
} from '../../../functions/_shared/drive'
import { deleteObject, isAtLeast, putObjectIfNewer, safeProviderCode, S3Error, type AssumedCredentials } from '../../../functions/_shared/s3'
import { getAssumedCredentials } from '../../../functions/_shared/s3Settings'
import type { GetEntryStatusInput, GetJobInput, MirrorResult, S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'
import type { WorkflowEnv } from './types'
import type { S3SyncIndex } from './syncIndex'
import type { DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'

export interface S3Config {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
}

const S3_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/
const S3_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const S3_REGION_RE = /^[a-z]{2}-[a-z]+-\d$/
const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PENDING_GRACE_MS = 20_000
// Request-scoped mirror operations write pending before external I/O. A later
// authenticated status request retries pending work that outlives the request.
const MIRROR_STALE_PENDING_MS = 5 * 60 * 1000

export function entryKey(date: string): string {
  return `diary-${date}.txt`
}

export function isValidDate(date: string): boolean {
  return DIARY_DATE_RE.test(date)
}

export async function authorizedSession(env: WorkflowEnv, auth: S3WorkflowAuth): Promise<SessionData> {
  if (!auth.sessionId || !auth.accountKey) throw new Error('Unauthorized')
  // A digest can only arrive here through a trusted workflow/DO payload. Pages
  // requests authenticate their raw cookie sessionId before making this RPC.
  const session = auth.sessionId.startsWith('sha256:')
    ? await getSessionByStorageId(auth.sessionId, env, auth.vaultKey)
    : await getSession(auth.sessionId, env, auth.vaultKey)
  if (!session || session.user_id !== auth.accountKey) throw new Error('Unauthorized')
  // These credentials arrive only on the trusted request-scoped service RPC.
  // They are attached to this in-memory session object and never saved.
  if (auth.accessToken) session.access_token = auth.accessToken
  if (auth.expiresAt !== undefined) session.expires_at = auth.expiresAt
  if (auth.idToken) {
    session.id_token = auth.idToken
    session.id_token_verified = true
  }
  return session
}

export async function ensureAccountDiaryFolder(
  env: WorkflowEnv,
  sessionId: string,
  session: SessionData,
  vaultKey?: string,
): Promise<string> {
  const accountKey = session.user_id
  if (!accountKey) throw new Error('Linger account identity missing; sign in again')
  if (!session.access_token || !session.expires_at) throw new Error('Request-scoped Google credentials are required')
  const auth: DiaryWriterAuth = {
    sessionId,
    accountKey,
    accessToken: session.access_token,
    expiresAt: session.expires_at,
    ...(session.id_token ? { idToken: session.id_token } : {}),
    ...(vaultKey ? { vaultKey } : {}),
  }
  const folderId = await env.DIARY_WRITER.getByName(accountKey).ensureFolder(auth)
  if (session.folder_id !== folderId) invalidateFolderScopedS3Cache(session)
  session.folder_id = folderId
  return folderId
}

export function indexFor(env: WorkflowEnv, accountKey: string): DurableObjectStub<S3SyncIndex> {
  return env.S3_SYNC_INDEX.getByName(accountKey)
}

// Namespaces are per user_id. This reserved name is separate from random
// user principals and reuses S3SyncIndex as an account-wide usage counter.
const USAGE_TRACKER_KEY = '__workflow_usage__'

// Cloudflare's Free plan includes 3,000 Workflow steps/day per account
// (https://developers.cloudflare.com/workflows/reference/pricing/). Budgeted
// below that so a runaway backfill can't silently consume the account's
// entire daily allowance for other Workers too; new backfills are refused
// once crossed, but jobs already running are left to finish.
export const DAILY_WORKFLOW_STEP_BUDGET = 2500

export function usageTrackerStub(env: WorkflowEnv): DurableObjectStub<S3SyncIndex> {
  return env.S3_SYNC_INDEX.getByName(USAGE_TRACKER_KEY)
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface WorkflowUsage {
  date: string
  steps: number
  budget: number
  remaining: number
}

export async function getWorkflowUsage(env: WorkflowEnv): Promise<WorkflowUsage> {
  const date = todayUTC()
  const steps = await usageTrackerStub(env).getWorkflowStepUsage(date)
  return { date, steps, budget: DAILY_WORKFLOW_STEP_BUDGET, remaining: Math.max(0, DAILY_WORKFLOW_STEP_BUDGET - steps) }
}

export async function assertWithinDailyStepBudget(env: WorkflowEnv): Promise<void> {
  const usage = await getWorkflowUsage(env)
  if (usage.steps >= usage.budget) {
    throw new Error(`Daily Workflow step budget (${usage.budget}) reached — try again after 00:00 UTC`)
  }
}

// Called from inside a Workflow step.do() callback only, so it runs exactly once
// per step even across replays (step.do memoizes a successful callback) — see
// `countedStep` below, which every step.do callback goes through.
export async function recordWorkflowStep(env: WorkflowEnv): Promise<void> {
  await usageTrackerStub(env).recordWorkflowStep(todayUTC())
}

// Every step.do() call either Workflow makes goes through here instead of calling
// step.do() directly, so the account-wide daily step counter (see
// recordWorkflowStep above) has a single choke point. Note it is NOT a mirror of
// what Cloudflare bills: CF's step billing excludes retries, while this counter
// increments inside the callback — which step.do re-runs on every retry — so the
// local count over-counts vs the real bill. That's deliberate: the budget is a
// self-imposed cap (assertWithinDailyStepBudget) sized under the Free allowance,
// and over-counting makes it strictly conservative. Counting inside the callback
// (rather than around step.do itself) still matters because step.do's wrapper
// re-executes on every replay and would overcount even more wildly.
export function countedStep<T extends Rpc.Serializable<T>>(env: WorkflowEnv, step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T>
export function countedStep<T extends Rpc.Serializable<T>>(env: WorkflowEnv, step: WorkflowStep, name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>
export function countedStep<T extends Rpc.Serializable<T>>(
  env: WorkflowEnv,
  step: WorkflowStep,
  name: string,
  configOrFn: WorkflowStepConfig | (() => Promise<T>),
  maybeFn?: () => Promise<T>,
): Promise<T> {
  const runSafely = async (fn: () => Promise<T>): Promise<T> => {
    try {
      await recordWorkflowStep(env)
      return await fn()
    } catch (error) {
      const message = safeError(error)
      if (error instanceof NonRetryableError) throw new NonRetryableError(message)
      throw new Error(message)
    }
  }
  if (typeof configOrFn === 'function') {
    return step.do(name, () => runSafely(configOrFn))
  }
  const fn = maybeFn as () => Promise<T>
  return step.do(name, configOrFn, () => runSafely(fn))
}

function parseS3Config(value: unknown): S3Config | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') return null
  if (typeof record.roleArn !== 'string' || !S3_ROLE_ARN_RE.test(record.roleArn)) return null
  if (typeof record.bucket !== 'string' || !S3_BUCKET_RE.test(record.bucket)) return null
  if (typeof record.region !== 'string' || !S3_REGION_RE.test(record.region)) return null
  return {
    enabled: record.enabled,
    roleArn: record.roleArn,
    bucket: record.bucket,
    region: record.region,
  }
}

export async function loadS3Config(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: WorkflowEnv,
  vaultKey?: string,
): Promise<S3Config | null> {
  const folderId = await ensureAccountDiaryFolder(env, sessionId, session, vaultKey)
  const fileId = await findJsonFile(accessToken, folderId, 's3_settings.json')
  if (!fileId) return null
  return parseS3Config(await readJsonFile<unknown>(accessToken, fileId))
}

export async function freshGoogleTokens(
  sessionId: string,
  session: SessionData,
  env: WorkflowEnv,
): Promise<{ accessToken: string; idToken: string }> {
  const accessToken = await getValidAccessToken(sessionId, session, env)
  const idToken = await getValidIdToken(sessionId, session, env)
  if (!idToken) throw new Error('Google identity token unavailable')
  return { accessToken, idToken }
}

// Routed through s3Settings.ts's KV-session-backed cache (getAssumedCredentials)
// rather than calling assumeRoleWithWebIdentity's in-isolate Map cache directly —
// the Workflow Worker's steps commonly resume on a different isolate than the one
// that assumed the role (step.sleep and any hibernation both evict it), so the
// in-isolate cache alone would re-pay a full STS round trip on nearly every step.
// The KV-backed cache survives that because it's read from/written to the same
// session record every step already loads via authorizedSession.
export async function assumeS3Credentials(
  idToken: string,
  sessionId: string,
  session: SessionData,
  env: WorkflowEnv,
  config: S3Config,
): Promise<AssumedCredentials> {
  return getAssumedCredentials(idToken, sessionId, session, env, config)
}

export function safeError(error: unknown): string {
  // Error messages can contain OAuth/AWS credentials or diary content. Keep only
  // stable error metadata when recording retry/status information.
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    const code = error instanceof Error ? safeProviderCode(error.message) : null
    return code ?? `Request failed (HTTP ${error.status})`
  }
  if (error instanceof Error) {
    const code = safeProviderCode(error.message)
    if (code) return code
  }
  if (error instanceof Error && error.message === 'No Google ID token in this session — sign out and sign in again') {
    return 'No Google ID token in this session — sign out and sign in again'
  }
  if (error instanceof Error) return 'Error occurred'
  return 'Unknown error'
}

// Drive quota errors (userRateLimitExceeded/rateLimitExceeded/quotaExceeded) and
// STS throttling/expiry (ThrottlingException/ExpiredTokenException) both come back
// as a plain 4xx status (403 and 400 respectively, not 429) — DriveError/S3Error's
// `message` carries the raw response body (see drive.ts's driveWithRetry and
// s3.ts), so matching against it here is the only way to tell these apart from a
// genuinely permanent 4xx (bad request, forbidden-for-real, etc). Without this, a
// transient quota bump or a stale id_token gets recorded as the entry's permanent,
// un-retriable failure instead of the next attempt (with a refreshed token, past
// the quota window) just working.
const RETRYABLE_ERROR_SIGNATURE = /rateLimitExceeded|quotaExceeded|ThrottlingException|ExpiredTokenException/i

export function isPermanentEntryError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error) {
    const status = Number((error as { status: number }).status)
    if (!(status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 409 && status !== 429)) return false
    return !RETRYABLE_ERROR_SIGNATURE.test(error.message)
  }
  return false
}

export function isMissingEntryError(error: unknown): boolean {
  return error instanceof Error && 'status' in error && Number((error as { status: number }).status) === 404
}

export async function getJobForAuth(env: WorkflowEnv, input: GetJobInput) {
  await authorizedSession(env, input)
  return indexFor(env, input.accountKey).getJob(input.jobId)
}

// A plain open or since-scoped status check reconciles missing or stale records in
// this authenticated request. It writes pending before Drive/S3 I/O and records a
// failure safely; a later authenticated request can retry the operation.
async function armLazyMirrorOrReport(
  env: WorkflowEnv,
  input: GetEntryStatusInput,
): Promise<{ status: 'synced' } | { status: 'failed'; error: string }> {
  // User keys cannot be placed in durable Workflow state. Reconcile inside this
  // authenticated request so protected metadata stays request-scoped.
  const outcome = await mirrorEntryForAuthNow(env, input)
  if (outcome.ok) return { status: 'synced' }
  return { status: 'failed', error: outcome.error ?? 'Mirror failed' }
}

export async function entryStatusForAuth(env: WorkflowEnv, input: GetEntryStatusInput) {
  await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  const enabled = await index.getBackupEnabled()
  if (enabled !== true) return { status: 'disabled' as const }

  const record = await index.getEntry(input.date)
  if (record?.syncedVersion && isAtLeast(record.syncedVersion, input.requestedVersion)) {
    return { status: 'synced' as const }
  }
  const since = input.since ? Date.parse(input.since) : NaN
  if (record?.state === 'pending') {
    const withinSaveGrace = !Number.isNaN(since) && Date.now() - since < PENDING_GRACE_MS
    const recordAge = Number.isFinite(record.updatedAt ? Date.parse(record.updatedAt) : NaN) ? Date.now() - Date.parse(record.updatedAt) : NaN
    // A fresh save's short grace window, plus the workflow's own retry budget
    // above — either means something is (or very recently was) actively working
    // toward this date, so keep reporting 'pending'. Once both have elapsed, the
    // pending record is stale (a never-started workflow, or one whose create
    // failed): re-arm the mirror here so the entry self-heals — for a since
    // (save) check just as for a plain open — and report the arm's outcome.
    if (withinSaveGrace || (Number.isFinite(recordAge) && recordAge < MIRROR_STALE_PENDING_MS)) {
      return { status: 'pending' as const }
    }
    return armLazyMirrorOrReport(env, input)
  }
  if (record?.state === 'failed') return { status: 'failed' as const, error: record.lastError }

  if (!Number.isNaN(since) && Date.now() - since < PENDING_GRACE_MS) return { status: 'pending' as const }
  // No record at all: this date was never mirrored (it predates S3 backup, was
  // created on another device after the last backfill, or the index was reset).
  // Re-arm it (a plain historic date that was never mirrored) — again for since
  // (save) checks no less than plain opens — and report the outcome.
  return armLazyMirrorOrReport(env, input)
}

export async function setBackupEnabledForAuth(
  env: WorkflowEnv,
  input: S3WorkflowAuth & { enabled: boolean; resetEntries?: boolean },
): Promise<void> {
  await authorizedSession(env, input)
  await indexFor(env, input.accountKey).setBackupEnabled(input.enabled, input.resetEntries ?? false)
}

export interface MirrorEntryCoreInput extends S3WorkflowAuth {
  date: string
  driveVersion?: string
  expectedBucket?: string
  jobId?: string
}

// All S3 mutations (including backfills and delete retries) run through the
// account's DO queue. Hints from old saves/listings never authorize a delete or
// supply a version stamp: Drive's current file is the authority on both.
export class SupersededBackfillError extends Error {
  constructor(message: string) { super(message); this.name = 'SupersededBackfillError' }
}

export async function mirrorEntryCore(env: WorkflowEnv, index: Pick<S3SyncIndex, 'getJob' | 'markPending' | 'markSynced' | 'markDeleted' | 'setBackupEnabled'>, input: MirrorEntryCoreInput): Promise<void> {
  const session = await authorizedSession(env, input)
  if (input.jobId) {
    const job = await index.getJob(input.jobId)
    if (!job || !['queued', 'running'].includes(job.state)) throw new SupersededBackfillError('Backfill is no longer active')
  }
  const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, env)
  const config = await loadS3Config(accessToken, input.sessionId, session, env, input.vaultKey)
  if (input.expectedBucket && config?.bucket !== input.expectedBucket) throw new SupersededBackfillError('S3 backup target changed')
  await index.setBackupEnabled(!!config?.enabled)
  if (!config?.enabled) {
    await index.markDeleted(input.date)
    return
  }
  const creds = await assumeS3Credentials(idToken, input.sessionId, session, env, config)
  // A concurrent Drive mutation may land during S3 I/O. Re-read after each write
  // and reconcile again rather than declaring stale content synced. Bound the
  // work; Workflow/alarm retries resume if a date keeps changing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const meta = await findCurrentEntry(accessToken, input.sessionId, session, env, input.date)
    if (!meta) {
      await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
      if (await findCurrentEntry(accessToken, input.sessionId, session, env, input.date)) continue
      await index.markDeleted(input.date)
      return
    }
    const version = meta.version
    await index.markPending(input.date, version, new Date().toISOString())
    let content: string
    try {
      content = (await getEntryContent(accessToken, meta.id, input.date)).content
    } catch (error) {
      if (isMissingEntryError(error)) continue
      throw error
    }
    await putObjectIfNewer(creds, config.bucket, config.region, entryKey(input.date), content, version, undefined, { fileId: meta.id })
    try {
      const current = await getDiaryFileMeta(accessToken, input.sessionId, session, env, meta.id, input.date)
      if (current.version !== version) continue
    } catch (error) {
      if (isMissingEntryError(error)) continue
      throw error
    }
    const synced = await index.markSynced(input.date, version, new Date().toISOString())
    if (synced?.driveVersion && version && synced.driveVersion !== version) continue
    return
  }
  throw new S3Error(409, 'Drive entry changed during S3 reconciliation')
}

// Mirror one date to S3 and await the outcome — used by api/s3/entry-resync's
// manual retry, which needs a synchronous result (and records any permanent
// failure back on the DO index) rather than the fire-and-forget workflow the
// plain mirrorEntry RPC schedules.
export async function mirrorEntryForAuthNow(env: WorkflowEnv, input: MirrorEntryCoreInput): Promise<MirrorResult> {
  const session = await authorizedSession(env, input)
  if (!session.access_token) return { ok: false, error: 'Request-scoped Google credentials are required' }
  const index = indexFor(env, input.accountKey)
  try {
    await index.reconcileEntry(input)
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, input.driveVersion, message, new Date().toISOString())
    return { ok: false, error: message }
  }
}

// create() throws if `id` already exists within the retention period — which
// here means a previous attempt's create actually succeeded but its response was
// lost. Confirm via get() before treating that as a genuine failure. Retention is
// kept short: mirror instances carry only one date's params (trivial), but a
// failed instance lingering at the default 3-day Free retention just wastes
// storage for no debugging value beyond a day.
// Reconcile within the authenticated service request. User vault keys and Google
// credentials are request-scoped and cannot be carried by durable Workflows.
export async function mirrorEntryForAuth(env: WorkflowEnv, input: MirrorEntryCoreInput): Promise<MirrorResult> {
  const session = await authorizedSession(env, input)
  if (!session.access_token) return { ok: false, error: 'Request-scoped Google credentials are required' }
  // An account that has never enabled (or explicitly disabled) S3 backup has
  // nothing for a mirror workflow to do: every save would otherwise pay 2 steps
  // plus ~5-7 external Drive/S3 subrequests just to discover config-enablement is
  // off and mark the entry deleted. The DO's enabled flag is kept in sync with the
  // Drive config by the settings save/read endpoints and by the mirror cores
  // themselves, so a flag of false is an exact "backup off" signal — with no
  // markPending, entryStatusForAuth keeps reporting 'disabled' for these saves just
  // as it does today (it gates on getBackupEnabled !== true). A null flag (never
  // configured, or priored to the flag's existence) still runs: its first mirror
  // learns the config is absent and flips the flag to false.
  const index = indexFor(env, input.accountKey)
  // An unexpected failure reading the enabled flag (the account DO hiccupeeing) must
  // not silently drop a save's backup: treat it as unknown (null → schedule the
  // mirror, which re-reads config from Drive and re-flips the flag via
  // setBackupEnabled inside mirrorEntryCore). Only an explicit flag of false — the
  // exact "backup off" signal — skips the workflow.
  let backupEnabled: boolean | null
  try {
    backupEnabled = await index.getBackupEnabled()
  } catch (error) {
    console.warn('s3Workflows: could not read backup-enabled flag; mirroring anyway')
    backupEnabled = null
  }
  if (backupEnabled === false) {
    return { ok: true }
  }
  await index.markPending(input.date, input.driveVersion, new Date().toISOString())
  try {
    await index.reconcileEntry(input)
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, input.driveVersion, message, new Date().toISOString())
    return { ok: false, error: message }
  }
}

export async function deleteEntryForAuth(env: WorkflowEnv, input: MirrorEntryCoreInput): Promise<MirrorResult> {
  const session = await authorizedSession(env, input)
  if (!session.access_token) return { ok: false, error: 'Request-scoped Google credentials are required' }
  const index = indexFor(env, input.accountKey)
  await index.markPending(input.date, undefined, new Date().toISOString())
  try {
    await index.reconcileEntry(input)
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, undefined, message, new Date().toISOString())
    return { ok: false, error: message }
  }
}

export async function findCurrentEntry(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: WorkflowEnv,
  date: string,
) {
  return findEntryMeta(accessToken, sessionId, session, env, date)
}
