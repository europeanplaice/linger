import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getValidAccessToken } from '../../../functions/_shared/session'
import { listEntryPage } from '../../../functions/_shared/drive'
import { isAtLeast } from '../../../functions/_shared/s3'
import type { S3BackfillParams, EntryPage, DiaryTarget, EntryProcessResult, WorkflowEnv } from './types'
import { authorizedSession, countedStep, indexFor, isPermanentEntryError, loadS3Config, safeError } from './runtime'

// Each date is reconciled in its own Durable Object RPC, giving it a separate
// external-request budget and serializing it against saves, deletes and target
// changes. Keep bounded batches/chunks for checkpoints and Workflow state size.
const BATCH_SIZE = 6
export const WORKFLOW_CHUNK_SIZE = 12
const MAX_BACKFILL_ENTRIES = 10_000
// Bookkeeping can retry more freely; keep work batches bounded so a long
// external outage does not consume the account's daily Workflow step budget.
const BOOKKEEPING_STEP_RETRIES = { limit: 3, delay: '5 seconds' as const, backoff: 'exponential' as const }
const EXTERNAL_STEP_RETRIES = { limit: 1, delay: '5 seconds' as const, backoff: 'exponential' as const }
const STEP_TIMEOUT = '2 minutes' as const

function targetsFromPage(page: EntryPage): DiaryTarget[] {
  return page.entries.filter(target => /^\d{4}-\d{2}-\d{2}$/.test(target.date))
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

// create() throws if `id` already exists within the retention period — which
// happens for real on a retried chain step whose first attempt actually created
// the successor instance but never got to record that fact as this step's own
// success. Confirm via get() before treating that as a genuine failure: without
// this, a transient blip here would fail the whole job and orphan an
// already-running successor chunk instead of just finishing quietly.
// successRetention must stay well above the chain step's worst-case retry window
// (see the chain-chunk step config): if a created successor were GC'd before a
// retried chain step could get() it, the retry's create() would succeed and spawn
// a duplicate successor chunk. It's also kept short because every chained
// instance's params carry the whole remaining scope — default 3-day retention
// would hold ~1GB of scope state across a large backfill (see cloudflare-workflows-plan.md).
async function createChainedInstance(env: WorkflowEnv, id: string, params: S3BackfillParams): Promise<void> {
  try {
    await env.S3_BACKFILL_WORKFLOW.create({
      id,
      params,
      retention: { successRetention: '1 hour', errorRetention: '1 day' },
    })
  } catch (error) {
    try {
      await env.S3_BACKFILL_WORKFLOW.get(id)
      return
    } catch {
      throw error
    }
  }
}

async function processBatch(
  env: WorkflowEnv,
  params: S3BackfillParams,
  targets: DiaryTarget[],
  step: WorkflowStep,
  batchKey: string,
): Promise<EntryProcessResult> {
  return countedStep(
    env,
    step,
    `backup-batch-${batchKey}`,
    { retries: EXTERNAL_STEP_RETRIES, timeout: STEP_TIMEOUT },
    async () => {
      const session = await authorizedSession(env, params)
      const accessToken = await getValidAccessToken(params.sessionId, session, env)
      const config = params.config ?? await loadS3Config(accessToken, params.sessionId, session, env)
      if (!config || !config.enabled) throw new NonRetryableError('S3 backup is not enabled')
      const index = indexFor(env, params.accountKey)
      // params.config is frozen at backfill start and carried through every chained
      // instance, so the DO's account_config flag is the only live authority on
      // whether the user still wants backup on. A user who disables S3 mid-backfill
      // (setBackupEnabledForAuth writes the flag) would otherwise have this job keep
      // syncing to a bucket they just switched off. Abort the whole job — the
      // NonRetryableError escapes the batch so step retry can't resurrect it.
      if (await index.getBackupEnabled() === false) {
        throw new NonRetryableError('S3 backup was disabled during the backfill')
      }
      const failedDates: string[] = []

      for (const target of targets) {
        try {
          const known = await index.getEntry(target.date)
          if (target.fileId && known?.fileId === target.fileId && target.version && known.state === 'synced' && known.syncedVersion && isAtLeast(known.syncedVersion, target.version)) continue
          await index.reconcileEntry({ sessionId: params.sessionId, accountKey: params.accountKey, date: target.date, expectedBucket: config.bucket, jobId: params.jobId })
        } catch (error) {
          if (error instanceof Error && error.name === 'SupersededBackfillError') throw new NonRetryableError(error.message)
          // A 4xx from Drive/S3 is an entry-specific failure. Network/5xx errors
          // escape the batch so Workflow retry can repeat the whole idempotent batch.
          if (!isPermanentEntryError(error)) throw error
          const message = safeError(error)
          failedDates.push(target.date)
          await index.markFailed(target.date, (await index.getEntry(target.date))?.driveVersion, message, new Date().toISOString())
        }
      }
      const result = { processed: targets.length, failedDates }
      // Folded into this same step (rather than a separate record-progress step)
      // to cut the Workflow's step count roughly in half — recordProgress's own
      // idempotency (INSERT OR IGNORE on processed_batches, see syncIndex.ts)
      // already makes this safe to run exactly once per successful step execution,
      // the same guarantee a separate step would have provided.
      await index.recordProgress(params.jobId, batchKey, result.processed, result.failedDates)
      return result
    },
  )
}

export class S3BackfillWorkflow extends WorkflowEntrypoint<WorkflowEnv, S3BackfillParams> {
  async run(event: WorkflowEvent<S3BackfillParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload
    const index = indexFor(this.env, params.accountKey)
    try {
      if (params.scope) {
        // markRunning and setTotal are folded into one step (they used to be
        // mark-job-running + set-scope-total) to cut a step per chunk: both are
        // idempotent DO bookkeeping, and setTotal uses MAX() so a chained chunk
        // re-running this step on a smaller remaining slice can never shrink the
        // job's total. Every chunk instance runs this, setting the total from the
        // full scope only on chunk index 0 and harmlessly re-raising otherwise.
        await countedStep(this.env, step, 'mark-job-running', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
          await index.markRunning(params.jobId)
          await index.setTotal(params.jobId, params.scope?.length ?? 0)
          return null
        })
        const chunkIdx = params.chunkIndex ?? 0
        const currentChunk = params.scope.slice(0, WORKFLOW_CHUNK_SIZE)
        const remainingScope = params.scope.slice(WORKFLOW_CHUNK_SIZE)

        const targetBatches = chunk(currentChunk, BATCH_SIZE)
        for (const [batchIndex, batch] of targetBatches.entries()) {
          const batchKey = `scope-c${chunkIdx}-b${batchIndex}`
          await processBatch(this.env, params, batch, step, batchKey)
        }

        if (remainingScope.length > 0) {
          const nextChunkIdx = chunkIdx + 1
          const nextWorkflowId = `${params.jobId}-chunk-${nextChunkIdx}`
          // Bookkeeping retries (Workflow-binding create/get only — no external
          // subrequests). Worst-case retry window is a handful of minutes, which
          // createChainedInstance's '1 hour' successRetention must exceed so a
          // created-but-unrecorded successor is still findable via get() on retry.
          await countedStep(this.env, step, `chain-chunk-${nextChunkIdx}`, { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
            await createChainedInstance(this.env, nextWorkflowId, { ...params, scope: remainingScope, chunkIndex: nextChunkIdx })
            return null
          })
          return
        }
      } else {
        await countedStep(this.env, step, 'mark-job-running', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
          await index.markRunning(params.jobId)
          return null
        })
        let pageToken: string | undefined
        let pageIndex = 0
        let discoveredCount = 0
        const allTargets: DiaryTarget[] = []
        do {
          const page = await countedStep(this.env, step, `discover-page-${pageIndex}`, { retries: EXTERNAL_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
            const session = await authorizedSession(this.env, params)
            const accessToken = await getValidAccessToken(params.sessionId, session, this.env)
            const entries = await listEntryPage(accessToken, params.sessionId, session, this.env, pageToken)
            return {
              entries: entries.files
                .map(file => ({ date: file.name.match(/^diary-(\d{4}-\d{2}-\d{2})\.(?:txt|md)$/)?.[1] ?? '', fileId: file.id, version: file.version }))
                .filter(target => target.date),
              ...(entries.nextPageToken ? { nextPageToken: entries.nextPageToken } : {}),
            } satisfies EntryPage
          })
          const pageTargets = targetsFromPage(page)
          allTargets.push(...pageTargets)
          discoveredCount += pageTargets.length
          if (discoveredCount > MAX_BACKFILL_ENTRIES) {
            throw new NonRetryableError('Backfill target limit exceeded')
          }
          pageToken = page.nextPageToken
          pageIndex += 1
        } while (pageToken)

        await countedStep(this.env, step, 'set-page-total', async () => {
          await index.setTotal(params.jobId, discoveredCount)
          return null
        })

        if (allTargets.length > 0) {
          const scope = allTargets
          const nextWorkflowId = `${params.jobId}-chunk-1`
          await countedStep(this.env, step, 'chain-first-chunk', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
            await createChainedInstance(this.env, nextWorkflowId, { ...params, scope, chunkIndex: 1 })
            return null
          })
          return
        }
      }

      await countedStep(this.env, step, 'mark-job-finished', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.finishJob(params.jobId, new Date().toISOString())
        return null
      })
    } catch (error) {
      const message = safeError(error)
      await countedStep(this.env, step, 'mark-job-failed', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.failJob(params.jobId, message, new Date().toISOString())
        return null
      })
      throw error
    }
  }
}
