import type { SessionData } from '../../../functions/_shared/session'
import {
  listEntryPage,
} from '../../../functions/_shared/drive'
import { isAtLeast } from '../../../functions/_shared/s3'
import type { S3Config } from './runtime'
import { indexFor } from './runtime'
import type { DiaryTarget, WorkflowEnv } from './types'

export interface FirstPassResult {
  isFinished: boolean
  remainingScope: DiaryTarget[]
}

// Each reconciliation has its own RPC request budget; cap the first pass so a
// manual retry can return promptly and delegate larger scopes to Workflows.
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
  scope?: DiaryTarget[],
): Promise<FirstPassResult> {
  const index = indexFor(env, accountKey)
  await index.markRunning(jobId)

  let targetsToProcess: DiaryTarget[]
  let remainingScope: DiaryTarget[]

  if (scope) {
    await index.setTotal(jobId, scope.length)
    targetsToProcess = scope.slice(0, WORKER_FIRST_PASS_BATCH_SIZE)
    remainingScope = scope.slice(WORKER_FIRST_PASS_BATCH_SIZE)
  } else {
    // Discovery path: list first page of entries
    const page = await listEntryPage(accessToken, sessionId, session, env)
    const allDiscovered: DiaryTarget[] = page.files
      .map(file => ({
        date: file.name.match(/^diary-(\d{4}-\d{2}-\d{2})\.(?:txt|md)$/)?.[1] ?? '',
        fileId: file.id,
        version: file.version,
      }))
      .filter(target => Boolean(target.date))

    await index.setTotal(jobId, allDiscovered.length)
    targetsToProcess = allDiscovered.slice(0, WORKER_FIRST_PASS_BATCH_SIZE)
    remainingScope = allDiscovered.slice(WORKER_FIRST_PASS_BATCH_SIZE)
  }

  if (targetsToProcess.length === 0) {
    return { isFinished: true, remainingScope: [] }
  }

  if (!idToken) {
    return { isFinished: false, remainingScope: scope ?? remainingScope }
  }

  try {
    const failedTargets: DiaryTarget[] = []
    let processed = 0

    for (const target of targetsToProcess) {
      try {
        const known = await index.getEntry(target.date)
        if (!(target.fileId && known?.fileId === target.fileId && target.version && known.state === 'synced' && known.syncedVersion && isAtLeast(known.syncedVersion, target.version))) {
          await index.reconcileEntry({ sessionId, accountKey, date: target.date, expectedBucket: config.bucket, jobId })
        }
        processed++
      } catch (e) {
        console.warn(`Worker first pass failed for date ${target.date}, delegating to Workflow retry:`, e)
        failedTargets.push(target)
        remainingScope.push(target)
      }
    }

    // Deferred entries are not failures until their Workflow retry fails.
    await index.recordProgress(jobId, 'worker-first-pass', processed, [])

    const isFinished = remainingScope.length === 0 && failedTargets.length === 0
    return { isFinished, remainingScope }
  } catch (e) {
    console.warn('Worker first pass STS/batch execution failed, delegating all to Workflow:', e)
    return { isFinished: false, remainingScope: scope ?? remainingScope }
  }
}
