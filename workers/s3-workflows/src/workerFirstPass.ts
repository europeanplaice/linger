import type { SessionData } from '../../../functions/_shared/session'
import {
  findEntryMeta,
  getDiaryFileMeta,
  getEntryContent,
  listEntryPage,
} from '../../../functions/_shared/drive'
import { putObjectIfNewer } from '../../../functions/_shared/s3'
import type { S3Config } from './runtime'
import { assumeS3Credentials, entryKey, indexFor } from './runtime'
import type { WorkflowEnv } from './types'

export interface FirstPassResult {
  isFinished: boolean
  remainingScope: string[]
}

const WORKER_FIRST_PASS_BATCH_SIZE = 10

export async function runWorkerFirstPass(
  env: WorkflowEnv,
  sessionId: string,
  session: SessionData,
  accountKey: string,
  jobId: string,
  config: S3Config,
  accessToken: string,
  idToken: string | undefined,
  scope?: string[],
): Promise<FirstPassResult> {
  const index = indexFor(env, accountKey)
  await index.markRunning(jobId)

  let targetsToProcess: { date: string; fileId?: string }[] = []
  let remainingScope: string[] = []

  if (scope) {
    await index.setTotal(jobId, scope.length)
    const currentBatch = scope.slice(0, WORKER_FIRST_PASS_BATCH_SIZE)
    remainingScope = scope.slice(WORKER_FIRST_PASS_BATCH_SIZE)
    targetsToProcess = currentBatch.map(date => ({ date }))
  } else {
    // Discovery path: list first page of entries
    const page = await listEntryPage(accessToken, sessionId, session, env)
    const allDiscovered = page.files
      .map(file => ({
        date: file.name.match(/^diary-(\d{4}-\d{2}-\d{2})\.(?:txt|md)$/)?.[1] ?? '',
        fileId: file.id,
      }))
      .filter(target => Boolean(target.date))

    await index.setTotal(jobId, allDiscovered.length)
    targetsToProcess = allDiscovered.slice(0, WORKER_FIRST_PASS_BATCH_SIZE)
    remainingScope = allDiscovered.slice(WORKER_FIRST_PASS_BATCH_SIZE).map(t => t.date)
  }

  if (targetsToProcess.length === 0) {
    return { isFinished: true, remainingScope: [] }
  }

  if (!idToken) {
    return { isFinished: false, remainingScope: scope ?? remainingScope }
  }

  try {
    const credentials = await assumeS3Credentials(idToken, accountKey, config)
    const failedDates: string[] = []
    let processed = 0

    for (const target of targetsToProcess) {
      try {
        const meta = target.fileId
          ? await getDiaryFileMeta(accessToken, sessionId, session, env, target.fileId, target.date)
          : await findEntryMeta(accessToken, sessionId, session, env, target.date)

        if (!meta) {
          await index.markDeleted(target.date)
          processed++
          continue
        }

        await index.markPending(target.date, meta.version ?? '1', new Date().toISOString())
        const { content } = await getEntryContent(accessToken, meta.id, target.date)
        await putObjectIfNewer(credentials, config.bucket, config.region, entryKey(target.date), content, meta.version)
        await index.markSynced(target.date, meta.version, new Date().toISOString())
        processed++
      } catch (e) {
        console.warn(`Worker first pass failed for date ${target.date}, delegating to Workflow retry:`, e)
        failedDates.push(target.date)
        remainingScope.push(target.date)
      }
    }

    await index.recordProgress(jobId, 'worker-first-pass', processed, failedDates)

    const isFinished = remainingScope.length === 0 && failedDates.length === 0
    return { isFinished, remainingScope }
  } catch (e) {
    console.warn('Worker first pass STS/batch execution failed, delegating all to Workflow:', e)
    return { isFinished: false, remainingScope: scope ?? remainingScope }
  }
}
