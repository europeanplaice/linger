import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import type { SessionData } from '../../../functions/_shared/session'
import { getSession, getValidAccessToken, getValidIdToken } from '../../../functions/_shared/session'
import {
  ensureFolder,
  findEntryMeta,
  findJsonFile,
  getDiaryFileMeta,
  getEntryContent,
  readJsonFile,
} from '../../../functions/_shared/drive'
import { deleteObject, describeError, putObjectIfNewer, type AssumedCredentials } from '../../../functions/_shared/s3'
import { getAssumedCredentials } from '../../../functions/_shared/s3Settings'
import type { GetEntryStatusInput, GetJobInput, MirrorResult, S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'
import type { MirrorWorkflowParams, WorkflowEnv } from './types'
import type { S3SyncIndex } from './syncIndex'

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
// How long a `pending` record is still trusted to mean "a mirror workflow is
// genuinely working toward this and will update it on its own" before it's
// treated as stale and reported as 'unconfirmed' (nothing is driving it and a
// manual retry is the only way forward). Sized against the mirror workflow's
// worst-case step: STEP_TIMEOUT (2 min) x (EXTERNAL_STEP_RETRIES.limit + 1)
// attempts plus the exponential backoff between them, so a step that's
// legitimately still retrying is never misreported as abandoned.
const MIRROR_STALE_PENDING_MS = 5 * 60 * 1000

export function entryKey(date: string): string {
  return `diary-${date}.txt`
}

export function isValidDate(date: string): boolean {
  return DIARY_DATE_RE.test(date)
}

export async function authorizedSession(env: WorkflowEnv, auth: S3WorkflowAuth): Promise<SessionData> {
  if (!auth.sessionId || !auth.accountKey) throw new Error('Unauthorized')
  const session = await getSession(auth.sessionId, env)
  if (!session || session.google_sub !== auth.accountKey) throw new Error('Unauthorized')
  return session
}

export function indexFor(env: WorkflowEnv, accountKey: string): DurableObjectStub<S3SyncIndex> {
  return env.S3_SYNC_INDEX.getByName(accountKey)
}

// Google `sub` values (used as accountKey) are always numeric strings, so this
// name can never collide with a real account and can safely reuse the
// S3SyncIndex class as a singleton, account-wide counter — see
// recordWorkflowStep's comment in syncIndex.ts for why that's safe.
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
// recordWorkflowStep above) tracks the same "step" unit Cloudflare bills against.
// Counting happens inside the callback — which step.do only ever runs once per
// step, even across replays — rather than around step.do itself, which
// re-executes on every replay and would overcount.
export function countedStep<T extends Rpc.Serializable<T>>(env: WorkflowEnv, step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T>
export function countedStep<T extends Rpc.Serializable<T>>(env: WorkflowEnv, step: WorkflowStep, name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>
export function countedStep<T extends Rpc.Serializable<T>>(
  env: WorkflowEnv,
  step: WorkflowStep,
  name: string,
  configOrFn: WorkflowStepConfig | (() => Promise<T>),
  maybeFn?: () => Promise<T>,
): Promise<T> {
  if (typeof configOrFn === 'function') {
    return step.do(name, async () => {
      await recordWorkflowStep(env)
      return configOrFn()
    })
  }
  const fn = maybeFn as () => Promise<T>
  return step.do(name, configOrFn, async () => {
    await recordWorkflowStep(env)
    return fn()
  })
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
): Promise<S3Config | null> {
  const folderId = await ensureFolder(accessToken, sessionId, session, env)
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
  const message = describeError(error)
  // Two passes: the first strips "Bearer <value>" specifically, since "Bearer" is
  // itself one of the second pass's trigger words and would otherwise be consumed
  // as if it were the *value* of a preceding "Authorization:" (leaving the actual
  // token untouched right after it). The second pass then handles the remaining
  // "keyword[:=]? value" shapes (Authorization:, secret=, access_key ...).
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer redacted')
    .replace(/(Authorization|token|secret|access.?key)\s*[:=]?\s*\S*/gi, '$1 redacted')
    .slice(0, 200)
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

export async function entryStatusForAuth(env: WorkflowEnv, input: GetEntryStatusInput) {
  await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  const enabled = await index.getBackupEnabled()
  if (enabled !== true) return { status: 'disabled' as const }

  const record = await index.getEntry(input.date)
  if (record?.syncedVersion && isAtLeast(record.syncedVersion, input.requestedVersion)) {
    return { status: 'synced' as const }
  }
  if (record?.state === 'pending') {
    const since = input.since ? Date.parse(input.since) : NaN
    const withinSaveGrace = !Number.isNaN(since) && Date.now() - since < PENDING_GRACE_MS
    const recordAge = Number.isFinite(record.updatedAt ? Date.parse(record.updatedAt) : NaN) ? Date.now() - Date.parse(record.updatedAt) : NaN
    // A fresh save's short grace window, plus the workflow's own retry budget
    // above — either means something is (or very recently was) actively working
    // toward this date, so keep reporting 'pending'. Once both have elapsed, the
    // pending record is stale (a never-started workflow, or one whose create
    // failed) — surface 'unconfirmed' so the client stops spinning and offers a
    // retry instead of leaving the badge stuck forever.
    if (withinSaveGrace || (Number.isFinite(recordAge) && recordAge < MIRROR_STALE_PENDING_MS)) {
      return { status: 'pending' as const }
    }
    return { status: 'unconfirmed' as const }
  }
  if (record?.state === 'failed') return { status: 'failed' as const, error: record.lastError }

  const since = input.since ? Date.parse(input.since) : NaN
  if (!Number.isNaN(since) && Date.now() - since < PENDING_GRACE_MS) return { status: 'pending' as const }
  return { status: 'unconfirmed' as const }
}

export async function setBackupEnabledForAuth(
  env: WorkflowEnv,
  input: { sessionId: string; accountKey: string; enabled: boolean; resetEntries?: boolean },
): Promise<void> {
  await authorizedSession(env, input)
  await indexFor(env, input.accountKey).setBackupEnabled(input.enabled, input.resetEntries ?? false)
}

export interface MirrorEntryCoreInput {
  sessionId: string
  accountKey: string
  date: string
  fileId?: string
  driveVersion?: string
}

// The actual mirror work for one date, shared by the S3MirrorWorkflow steps and
// the awaited mirrorEntryNow RPC (see index.ts). Always marks the DO index as it
// goes (pending → synced/deleted) but, unlike the old mirrorEntryForAuth, never
// swallows failures: a transient Drive/STS/S3 error is rethrown so the Workflow
// step's retry (or the caller) can repeat the whole idempotent mirror, and only
// the callers decide when an error is permanent enough to mark the entry failed.
export async function mirrorEntryCore(env: WorkflowEnv, index: DurableObjectStub<S3SyncIndex>, input: MirrorEntryCoreInput): Promise<void> {
  const session = await authorizedSession(env, input)
  await index.markPending(input.date, input.driveVersion, new Date().toISOString())

  const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, env)
  const config = await loadS3Config(accessToken, input.sessionId, session, env)
  await index.setBackupEnabled(!!config?.enabled)
  if (!config || !config.enabled) {
    await index.markDeleted(input.date)
    return
  }
  const creds = await assumeS3Credentials(idToken, input.sessionId, session, env, config)
  let meta
  try {
    meta = input.fileId
      ? await getDiaryFileMeta(accessToken, input.sessionId, session, env, input.fileId, input.date)
      : await findCurrentEntry(accessToken, input.sessionId, session, env, input.date)
    if (!meta) {
      await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
      await index.markDeleted(input.date)
      return
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
      await index.markDeleted(input.date)
      return
    }
    throw error
  }
  const { content } = await getEntryContent(accessToken, meta.id, input.date)
  await putObjectIfNewer(creds, config.bucket, config.region, entryKey(input.date), content, meta.version)
  try {
    await getDiaryFileMeta(accessToken, input.sessionId, session, env, meta.id, input.date)
  } catch (error) {
    if (isMissingEntryError(error)) {
      await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
      await index.markDeleted(input.date)
      return
    }
    throw error
  }
  await index.markSynced(input.date, meta.version, new Date().toISOString())
}

// Mirror one date to S3 and await the outcome — used by api/s3/entry-resync's
// manual retry, which needs a synchronous result (and records any permanent
// failure back on the DO index) rather than the fire-and-forget workflow the
// plain mirrorEntry RPC schedules.
export async function mirrorEntryForAuthNow(env: WorkflowEnv, input: MirrorEntryCoreInput): Promise<MirrorResult> {
  const index = indexFor(env, input.accountKey)
  try {
    await mirrorEntryCore(env, index, input)
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, input.driveVersion, message, new Date().toISOString())
    return { ok: false, error: message }
  }
}

// create() throws if `id` already exists within the retention period — which
// here means a previous attempt's create actually succeeded but its response was
// lost. Confirm via get() before treating that as a genuine failure.
async function createMirrorWorkflow(env: WorkflowEnv, id: string, params: MirrorWorkflowParams): Promise<void> {
  try {
    await env.S3_MIRROR_WORKFLOW.create({ id, params })
  } catch (error) {
    try {
      await env.S3_MIRROR_WORKFLOW.get(id)
      return
    } catch {
      throw error
    }
  }
}

// Fire-and-forget mirror: marks the entry pending and hands the actual Drive→S3
// mirror off to a dedicated S3MirrorWorkflow instance (whose steps retry
// transient failures — see mirrorWorkflow.ts), returning immediately so the
// calling save endpoint's context.waitUntil doesn't race a long mirror against
// its 30s budget. The Drive save itself has already succeeded by the time this
// runs, so a failure to even schedule the workflow is swallowed (the entry stays
// 'pending'; entryStatusForAuth's stale-pending aging surfaces it as
// 'unconfirmed' with a retry affordance rather than an eternal spinner).
export async function mirrorEntryForAuth(env: WorkflowEnv, input: MirrorEntryCoreInput): Promise<MirrorResult> {
  await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  await index.markPending(input.date, input.driveVersion, new Date().toISOString())
  try {
    await createMirrorWorkflow(env, crypto.randomUUID(), { ...input, kind: 'mirror' })
    return { ok: true }
  } catch (error) {
    console.error('s3Workflows: failed to start mirror workflow', error)
    return { ok: true }
  }
}

export async function deleteEntryForAuth(env: WorkflowEnv, input: { sessionId: string; accountKey: string; date: string }): Promise<MirrorResult> {
  await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  await index.markPending(input.date, undefined, new Date().toISOString())
  try {
    await createMirrorWorkflow(env, crypto.randomUUID(), { ...input, kind: 'delete' })
    return { ok: true }
  } catch (error) {
    console.error('s3Workflows: failed to start delete workflow', error)
    return { ok: true }
  }
}

// The S3 object-removal half of the mirror workflow's step — see the delete
// branch in mirrorWorkflow.ts. Same contract as mirrorEntryCore: throws on any
// failure so the step's retry (or caller) decides how to proceed.
export async function deleteEntryCore(env: WorkflowEnv, index: DurableObjectStub<S3SyncIndex>, input: { sessionId: string; accountKey: string; date: string }): Promise<void> {
  const session = await authorizedSession(env, input)
  await index.markPending(input.date, undefined, new Date().toISOString())

  const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, env)
  const config = await loadS3Config(accessToken, input.sessionId, session, env)
  await index.setBackupEnabled(!!config?.enabled)
  if (!config || !config.enabled) {
    await index.markDeleted(input.date)
    return
  }
  const creds = await assumeS3Credentials(idToken, input.sessionId, session, env, config)
  await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
  await index.markDeleted(input.date)
}

export function isAtLeast(existing: string, incoming: string): boolean {
  try {
    return BigInt(existing) >= BigInt(incoming)
  } catch {
    return false
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
