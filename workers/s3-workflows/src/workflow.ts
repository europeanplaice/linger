import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getValidAccessToken, getValidIdToken } from '../../../functions/_shared/session'
import { getEntryContent, listEntryPage } from '../../../functions/_shared/drive'
import { putObjectIfNewer } from '../../../functions/_shared/s3'
import type { S3BackfillParams, EntryPage, DiaryTarget, EntryProcessResult, WorkflowEnv } from './types'
import { authorizedSession, assumeS3Credentials, countedStep, entryKey, findCurrentEntry, indexFor, isAtLeast, isMissingEntryError, isPermanentEntryError, loadS3Config, safeError } from './runtime'

// A new (not-yet-synced) entry costs up to 2 external subrequests: Drive content and a
// single S3 If-None-Match PUT (see s3.ts's putObjectIfNewer — conditional writes made
// the old Drive-meta + S3 HEAD + PUT + post-write HEAD sequence unnecessary, and
// listing-derived targets carry their fileId/version straight from the listing). An
// update to an already-mirrored date costs 3: Drive content + S3 HEAD + If-Match PUT.
// STS AssumeRoleWithWebIdentity is only a subrequest on a credential-cache miss (the
// KV-backed cache in assumeS3Credentials usually absorbs it). An entry already synced at
// the version a listing/scope already knows about short-circuits to a single internal DO
// lookup instead (see the DO-index check in processBatch), so a Resync of a mostly-
// already-synced account costs far less than this bounds.
// WORKFLOW_CHUNK_SIZE keeps a worst-case chunk (every entry an update: 3 each) to
// 12 x 3 = 36 subrequests — real headroom under Cloudflare Workers Free plan's
// 50-subrequests-per-Workflow-instance pool, which (unlike step retries) is never reset
// mid-instance, including across step.sleep/hibernation. The rare 412-downgrade race (a
// concurrent mirror writing the same date) costs extra requests — up to 3 per affected
// entry (create 412 then HEAD + If-Match PUT) — but the pool absorbs a few of those before
// the batch step's own retry takes over. When more entries remain, the Workflow instance
// chains a fresh Workflow instance with the remaining scope, guaranteeing a brand-new
// Worker invocation and a fresh 50-subrequest pool. BATCH_SIZE keeps a single batch (plus
// its step retry, which re-runs the whole idempotent batch) inside the same pool:
// 6 x 3 = 18, doubled to 36 on a retry, with the one-off STS call still fitting.
const BATCH_SIZE = 6
const WORKFLOW_CHUNK_SIZE = 12
const MAX_BACKFILL_ENTRIES = 10_000
// Steps that only touch the Durable Object / Workflow-binding (not the external
// Drive/S3 subrequest budget) can retry generously — those calls don't compete
// with the pooled, never-resets-mid-instance subrequest limit above.
const BOOKKEEPING_STEP_RETRIES = { limit: 3, delay: '5 seconds' as const, backoff: 'exponential' as const }
// Steps that spend external Drive/S3/STS subrequests get only one retry: because
// the subrequest budget is pooled across the whole Workflow instance, retrying a
// step that failed from exhausting that budget only guarantees it fails again,
// burning further steps (and daily step budget) for no chance of success.
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
      const idToken = await getValidIdToken(params.sessionId, session, env)
      if (!idToken) throw new NonRetryableError('Google identity token unavailable')
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
      const credentials = await assumeS3Credentials(idToken, params.sessionId, session, env, config)
      const failedDates: string[] = []

      for (const target of targets) {
        let version: string | undefined
        try {
          // The DO index short-circuit: already mirrored at this exact Drive version
          // (known from a listing, not a stale guess) confirms with one internal call
          // instead of any Drive/S3 subrequest at all, so a Resync that mostly
          // rediscovers already-synced entries doesn't re-pay cost for every one of
          // them. The same record also tells us expectExisting for the S3 write.
          const known = await index.getEntry(target.date)
          if (target.version) {
            if (known?.state === 'synced' && known.syncedVersion && isAtLeast(known.syncedVersion, target.version)) continue
            version = target.version
          }
          // Listing-derived targets (fileId + version known) skip the Drive metadata
          // round-trip: the content fetch below still catches a mid-run deletion (404),
          // and a Drive version bumped after the listing is caught by the next
          // listing/resync, since putObjectIfNewer's conditional write stamps only the
          // version we know. That stamp can lag the content by a version if Drive bumps
          // between the listing and the fetch — harmless, because the DO index's
          // monotonic markSynced never regresses and a later save at the newer version
          // re-mirrors. findCurrentEntry remains for name-only scope targets.
          const meta = target.fileId
            ? { id: target.fileId, version: target.version }
            : await findCurrentEntry(accessToken, params.sessionId, session, env, target.date)
          if (!meta) {
            await index.markDeleted(target.date)
            continue
          }
          version = meta.version ?? version
          await index.markPending(target.date, version, new Date().toISOString())
          const { content } = await getEntryContent(accessToken, meta.id, target.date)
          await putObjectIfNewer(credentials, config.bucket, config.region, entryKey(target.date), content, version, undefined, { expectExisting: known?.state === 'synced' })
          await index.markSynced(target.date, version, new Date().toISOString())
        } catch (error) {
          if (isMissingEntryError(error)) {
            await index.markDeleted(target.date)
            continue
          }
          // A 4xx from Drive/S3 is an entry-specific failure. Network/5xx errors
          // escape the batch so Workflow retry can repeat the whole idempotent batch.
          if (!isPermanentEntryError(error)) throw error
          const message = safeError(error)
          failedDates.push(target.date)
          await index.markFailed(target.date, version, message, new Date().toISOString())
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
      await countedStep(this.env, step, 'mark-job-running', { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.markRunning(params.jobId)
        return null
      })

      if (params.scope) {
        await countedStep(this.env, step, 'set-scope-total', async () => {
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
