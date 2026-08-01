import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getValidAccessToken, getValidIdToken } from '../../../functions/_shared/session'
import { getDiaryFileMeta, getEntryContent, listEntryPage } from '../../../functions/_shared/drive'
import { deleteObject, putObjectIfNewer } from '../../../functions/_shared/s3'
import type { S3BackfillParams, EntryPage, DiaryTarget, EntryProcessResult, WorkflowEnv } from './types'
import { authorizedSession, assumeS3Credentials, entryKey, findCurrentEntry, indexFor, isMissingEntryError, isPermanentEntryError, loadS3Config, safeError } from './runtime'

const BATCH_SIZE = 20
const MAX_BACKFILL_ENTRIES = 10_000
const STEP_RETRIES = { limit: 3, delay: '5 seconds' as const, backoff: 'exponential' as const }
const STEP_TIMEOUT = '2 minutes' as const

function targetsFromPage(page: EntryPage): DiaryTarget[] {
  return page.entries.filter(target => /^\d{4}-\d{2}-\d{2}$/.test(target.date))
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function processBatch(
  env: WorkflowEnv,
  params: S3BackfillParams,
  targets: DiaryTarget[],
  step: WorkflowStep,
  batchKey: string,
): Promise<EntryProcessResult> {
  return step.do(
    `backup-batch-${batchKey}`,
    { retries: STEP_RETRIES, timeout: STEP_TIMEOUT },
    async () => {
      const session = await authorizedSession(env, params)
      const accessToken = await getValidAccessToken(params.sessionId, session, env)
      const idToken = await getValidIdToken(params.sessionId, session, env)
      if (!idToken) throw new NonRetryableError('Google identity token unavailable')
      const config = await loadS3Config(accessToken, params.sessionId, session, env)
      if (!config || !config.enabled) throw new NonRetryableError('S3 backup is not enabled')
      const credentials = await assumeS3Credentials(idToken, params.accountKey, config)
      const index = indexFor(env, params.accountKey)
      const failedDates: string[] = []

      for (const target of targets) {
        let meta
        try {
          meta = target.fileId
            ? await getDiaryFileMeta(accessToken, params.sessionId, session, env, target.fileId, target.date)
            : await findCurrentEntry(accessToken, params.sessionId, session, env, target.date)
          if (!meta) {
            await index.markDeleted(target.date)
            continue
          }
          await index.markPending(target.date, meta.version ?? target.version, new Date().toISOString())
          const { content } = await getEntryContent(accessToken, meta.id, target.date)
          await putObjectIfNewer(credentials, config.bucket, config.region, entryKey(target.date), content, meta.version)
          try {
            await getDiaryFileMeta(accessToken, params.sessionId, session, env, meta.id, target.date)
          } catch (error) {
            if (!isMissingEntryError(error)) throw error
            await deleteObject(credentials, config.bucket, config.region, entryKey(target.date))
            await index.markDeleted(target.date)
            continue
          }
          await index.markSynced(target.date, meta.version, new Date().toISOString())
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
          await index.markFailed(target.date, meta?.version ?? target.version, message, new Date().toISOString())
        }
      }
      return { processed: targets.length, failedDates }
    },
  )
}

export class S3BackfillWorkflow extends WorkflowEntrypoint<WorkflowEnv, S3BackfillParams> {
  async run(event: WorkflowEvent<S3BackfillParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload
    const index = indexFor(this.env, params.accountKey)
    try {
      await step.do('mark-job-running', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.markRunning(params.jobId)
        return null
      })

      if (params.scope) {
        await step.do('set-scope-total', async () => {
          await index.setTotal(params.jobId, params.scope?.length ?? 0)
          return null
        })
        const targetBatches = chunk(params.scope, BATCH_SIZE).map(batch => batch.map(date => ({ date, fileId: '' })))
        for (const [batchIndex, batch] of targetBatches.entries()) {
          const result = await processBatch(this.env, params, batch, step, `scope-${batchIndex}`)
          await step.do(`record-progress-scope-${batchIndex}`, { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
            await index.recordProgress(params.jobId, `scope-${batchIndex}`, result.processed, result.failedDates)
            return null
          })
        }
      } else {
        let pageToken: string | undefined
        let pageIndex = 0
        let discoveredCount = 0
        do {
          const page = await step.do(`discover-page-${pageIndex}`, { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
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
          discoveredCount += pageTargets.length
          if (discoveredCount > MAX_BACKFILL_ENTRIES) {
            throw new NonRetryableError('Backfill target limit exceeded')
          }
          await step.do(`set-page-total-${pageIndex}`, async () => {
            await index.setTotal(params.jobId, discoveredCount)
            return null
          })
          for (const [batchIndex, batch] of chunk(pageTargets, BATCH_SIZE).entries()) {
            const result = await processBatch(this.env, params, batch, step, `page-${pageIndex}-batch-${batchIndex}`)
            await step.do(`record-progress-page-${pageIndex}-batch-${batchIndex}`, { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
              await index.recordProgress(params.jobId, `page-${pageIndex}-batch-${batchIndex}`, result.processed, result.failedDates)
              return null
            })
          }
          pageToken = page.nextPageToken
          pageIndex += 1
        } while (pageToken)
      }

      await step.do('mark-job-finished', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.finishJob(params.jobId, new Date().toISOString())
        return null
      })
    } catch (error) {
      const message = safeError(error)
      await step.do('mark-job-failed', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        await index.failJob(params.jobId, message, new Date().toISOString())
        return null
      })
      throw error
    }
  }
}
