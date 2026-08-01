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
import { assumeRoleWithWebIdentity, deleteObject, describeError, putObjectIfNewer, type AssumedCredentials } from '../../../functions/_shared/s3'
import type { GetEntryStatusInput, GetJobInput, S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'
import type { WorkflowEnv } from './types'
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
// workflow.ts's `tracked()` wrapper, which every step.do callback goes through.
export async function recordWorkflowStep(env: WorkflowEnv): Promise<void> {
  await usageTrackerStub(env).recordWorkflowStep(todayUTC())
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

export async function assumeS3Credentials(
  idToken: string,
  accountKey: string,
  config: S3Config,
): Promise<AssumedCredentials> {
  return assumeRoleWithWebIdentity(idToken, config.roleArn, config.region, `${accountKey}:${config.roleArn}:${config.region}`)
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

export function isPermanentEntryError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error) {
    const status = Number((error as { status: number }).status)
    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 409 && status !== 429
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
  if (record?.state === 'pending') return { status: 'pending' as const }
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

export async function mirrorEntryForAuth(
  env: WorkflowEnv,
  input: { sessionId: string; accountKey: string; date: string; fileId?: string; driveVersion?: string },
): Promise<{ ok: boolean; error?: string }> {
  const session = await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  const pendingAt = new Date().toISOString()
  await index.markPending(input.date, input.driveVersion, pendingAt)

  try {
    const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, env)
    const config = await loadS3Config(accessToken, input.sessionId, session, env)
    await index.setBackupEnabled(!!config?.enabled)
    if (!config || !config.enabled) {
      await index.markDeleted(input.date)
      return { ok: true }
    }
    const creds = await assumeS3Credentials(idToken, input.accountKey, config)
    let meta
    try {
      meta = input.fileId
        ? await getDiaryFileMeta(accessToken, input.sessionId, session, env, input.fileId, input.date)
        : await findCurrentEntry(accessToken, input.sessionId, session, env, input.date)
      if (!meta) {
        await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
        await index.markDeleted(input.date)
        return { ok: true }
      }
    } catch (error) {
      if (isMissingEntryError(error)) {
        await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
        await index.markDeleted(input.date)
        return { ok: true }
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
        return { ok: true }
      }
      throw error
    }
    await index.markSynced(input.date, meta.version, new Date().toISOString())
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, input.driveVersion, message, new Date().toISOString())
    return { ok: false, error: message }
  }
}

export async function deleteEntryForAuth(
  env: WorkflowEnv,
  input: { sessionId: string; accountKey: string; date: string },
): Promise<{ ok: boolean; error?: string }> {
  const session = await authorizedSession(env, input)
  const index = indexFor(env, input.accountKey)
  await index.markPending(input.date, undefined, new Date().toISOString())
  try {
    const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, env)
    const config = await loadS3Config(accessToken, input.sessionId, session, env)
    await index.setBackupEnabled(!!config?.enabled)
    if (!config || !config.enabled) {
      await index.markDeleted(input.date)
      return { ok: true }
    }
    const creds = await assumeS3Credentials(idToken, input.accountKey, config)
    await deleteObject(creds, config.bucket, config.region, entryKey(input.date))
    await index.markDeleted(input.date)
    return { ok: true }
  } catch (error) {
    const message = safeError(error)
    await index.markFailed(input.date, undefined, message, new Date().toISOString())
    return { ok: false, error: message }
  }
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
