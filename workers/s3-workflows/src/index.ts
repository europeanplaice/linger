import { WorkerEntrypoint } from 'cloudflare:workers'
import type {
  DeleteEntryInput,
  GetEntryStatusInput,
  GetJobInput,
  MirrorEntryInput,
  StartBackfillInput,
  StartBackfillResult,
  SetBackupEnabledInput,
} from '../../../functions/_shared/s3Workflow'
import { assertWithinDailyStepBudget, authorizedSession, entryStatusForAuth, getJobForAuth, getWorkflowUsage, indexFor, isValidDate, loadS3Config, mirrorEntryForAuth, mirrorEntryForAuthNow, deleteEntryForAuth, freshGoogleTokens, safeError, setBackupEnabledForAuth } from './runtime'
import { S3BackfillWorkflow } from './workflow'
import { S3MirrorWorkflow } from './mirrorWorkflow'
import { S3SyncIndex } from './syncIndex'
import { runWorkerFirstPass } from './workerFirstPass'
import type { DiaryTarget, WorkflowEnv } from './types'

export { S3BackfillWorkflow, S3MirrorWorkflow, S3SyncIndex }

function validateRequestId(requestId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('Invalid request ID')
}

function validateScope(scope: string[] | undefined): string[] | undefined {
  if (scope === undefined) return undefined
  if (scope.length > 10_000 || scope.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('Invalid backfill scope')
  return [...new Set(scope)]
}

export default class S3WorkflowsService extends WorkerEntrypoint<WorkflowEnv> {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 })
  }

  async startBackfill(input: StartBackfillInput): Promise<StartBackfillResult> {
    validateRequestId(input.requestId)
    const scope = validateScope(input.scope)
    const session = await authorizedSession(this.env, input)
    const { accessToken, idToken } = await freshGoogleTokens(input.sessionId, session, this.env)
    const config = await loadS3Config(accessToken, input.sessionId, session, this.env)
    if (!config || !config.enabled) throw new Error('S3 backup is not enabled')
    await assertWithinDailyStepBudget(this.env)

    const jobId = crypto.randomUUID()
    const workflowId = crypto.randomUUID()
    const index = indexFor(this.env, input.accountKey)
    await index.setBackupEnabled(config.enabled)
    const reservation = await index.startJob(input.requestId, jobId, workflowId, config.enabled, new Date().toISOString())
    if (!reservation.created) return reservation

    let remainingScope: DiaryTarget[] | undefined = scope?.map(date => ({ date }))
    if (scope && scope.length > 0) {
      try {
        const firstPassResult = await runWorkerFirstPass(
          this.env,
          input.sessionId,
          session,
          input.accountKey,
          jobId,
          config,
          accessToken,
          idToken,
          remainingScope,
        )
        remainingScope = firstPassResult.remainingScope

        if (firstPassResult.isFinished) {
          await index.finishJob(jobId, new Date().toISOString())
          const finishedJob = await index.getJob(jobId)
          return { job: finishedJob!, created: true }
        }
      } catch (e) {
        console.warn('Worker first pass encountered non-fatal error, delegating to Workflow:', e)
      }
    }

    try {
      await this.env.S3_BACKFILL_WORKFLOW.create({
        id: workflowId,
        params: {
          sessionId: input.sessionId,
          accountKey: input.accountKey,
          jobId,
          config,
          ...(remainingScope ? { scope: remainingScope } : {}),
        },
      })
      return reservation
    } catch (error) {
      await index.markStartFailed(jobId, safeError(error), new Date().toISOString())
      throw error
    }
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

  async resetAllData(input: { sessionId: string; accountKey: string }): Promise<void> {
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
    if (!isValidDate(input.date)) throw new Error('Invalid date')
    return mirrorEntryForAuth(this.env, input)
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
