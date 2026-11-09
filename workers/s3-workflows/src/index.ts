import { WorkerEntrypoint } from 'cloudflare:workers'
import { cleanupAuth } from '../../../functions/_shared/authStore'
import type {
  DeleteEntryInput,
  GetEntryStatusInput,
  GetJobInput,
  MirrorEntryInput,
  StartBackfillInput,
  StartBackfillResult,
  SetBackupEnabledInput,
} from '../../../functions/_shared/s3Workflow'
import { authorizedSession, entryStatusForAuth, getJobForAuth, getWorkflowUsage, indexFor, isValidDate, mirrorEntryForAuthNow, deleteEntryForAuth, setBackupEnabledForAuth } from './runtime'
import { S3BackfillWorkflow } from './workflow'
import { S3MirrorWorkflow } from './mirrorWorkflow'
import { S3SyncIndex } from './syncIndex'
import type { WorkflowEnv } from './types'
import type { DiaryMutationInput, DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'
import { DiaryWriter } from './diaryWriter'
import type { S3Config } from './runtime'
import type { S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'

export { S3BackfillWorkflow, S3MirrorWorkflow, S3SyncIndex, DiaryWriter }

async function migrateSyncMetadata(env: WorkflowEnv, input: DiaryWriterAuth): Promise<void> {
  try {
    await indexFor(env, input.accountKey).migrateLegacyMetadata({ sessionId: input.sessionId, accountKey: input.accountKey, vaultKey: input.vaultKey })
  } catch {
    // Sync metadata is reconstructible. A corrupt legacy job or temporary index
    // outage must not prevent the user from accessing or saving the diary.
    console.warn('Legacy sync metadata migration deferred')
  }
}

export default class S3WorkflowsService extends WorkerEntrypoint<WorkflowEnv> {
  async scheduled(): Promise<void> {
    await cleanupAuth(this.env)
  }

  async saveSettings(input: S3WorkflowAuth & { config: S3Config }) {
    await authorizedSession(this.env, input)
    return indexFor(this.env, input.accountKey).saveBackupSettings(input)
  }

  async ensureDiaryFolder(input: DiaryWriterAuth): Promise<string> {
    await authorizedSession(this.env, input)
    await migrateSyncMetadata(this.env, input)
    return this.env.DIARY_WRITER.getByName(input.accountKey).ensureFolder(input)
  }

  async selectDiaryFolder(input: DiaryWriterAuth & { folderId: string }): Promise<string> {
    await authorizedSession(this.env, input)
    await migrateSyncMetadata(this.env, input)
    return this.env.DIARY_WRITER.getByName(input.accountKey).selectFolder(input)
  }

  async mutateDiaryEntry(input: DiaryMutationInput): Promise<Response> {
    await authorizedSession(this.env, input)
    await migrateSyncMetadata(this.env, input)
    return this.env.DIARY_WRITER.getByName(input.accountKey).mutate(input)
  }

  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 })
  }

  async startBackfill(input: StartBackfillInput): Promise<StartBackfillResult> {
    void input
    throw new Error('S3 background workflows are disabled; continue backup from the open browser session')
  }

  async getJob(input: GetJobInput) {
    return getJobForAuth(this.env, input)
  }

  // No account scoping — this account-wide throttle isn't per-user data, and every
  // caller is an already-authenticated Pages Function, not an end user directly.
  async getWorkflowUsage() {
    return getWorkflowUsage(this.env)
  }

  async getEntryStatus(input: GetEntryStatusInput) {
    if (!isValidDate(input.date)) throw new Error('Invalid date')
    return entryStatusForAuth(this.env, input)
  }

  async setBackupEnabled(input: SetBackupEnabledInput): Promise<void> {
    return setBackupEnabledForAuth(this.env, input)
  }

  async resetAllData(input: S3WorkflowAuth): Promise<void> {
    await authorizedSession(this.env, input)
    const index = indexFor(this.env, input.accountKey)
    await index.resetAllData()
  }

  // Fire-and-forget: marks the entry pending and schedules a dedicated
  // S3MirrorWorkflow instance (see mirrorWorkflow.ts) to do the actual mirror —
  // so the calling save endpoint's waitUntil can't race a long mirror against
  // its budget, and transient Drive/STS/S3 failures are retried by the
  // workflow's steps instead of failing the mirror on the first attempt.
  async mirrorEntry(input: MirrorEntryInput) {
    void input
    throw new Error('Durable S3 mirroring is disabled; use the request-scoped API')
  }

  // Awaited variant used by api/s3/entry-resync's manual retry, which needs a
  // synchronous outcome (and a definitive failure recorded on the index) rather
  // than the fire-and-forget workflow above.
  async mirrorEntryNow(input: MirrorEntryInput) {
    if (!isValidDate(input.date)) throw new Error('Invalid date')
    return mirrorEntryForAuthNow(this.env, input)
  }

  async deleteEntry(input: DeleteEntryInput) {
    if (!isValidDate(input.date)) throw new Error('Invalid date')
    return deleteEntryForAuth(this.env, input)
  }
}
