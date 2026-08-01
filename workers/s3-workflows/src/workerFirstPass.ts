import type { SessionData } from '../../../functions/_shared/session'
import {
  findEntryMeta,
  getDiaryFileMeta,
  getEntryContent,
  listEntryPage,
} from '../../../functions/_shared/drive'
import { putObjectIfNewer } from '../../../functions/_shared/s3'
import type { S3Config } from './runtime'
import { assumeS3Credentials, entryKey, indexFor, isAtLeast } from './runtime'
import type { DiaryTarget, WorkflowEnv } from './types'

export interface FirstPassResult {
  isFinished: boolean
  remainingScope: DiaryTarget[]
}

// Kept low because this runs inside a single plain Worker invocation (no chunk
// reset like the Workflow path gets) that also has to fit loadS3Config's Drive
// calls, token refresh, and the STS assume-role in the *same* 50-subrequest
// Free-plan budget as this batch — see workflow.ts's WORKFLOW_CHUNK_SIZE comment
// for the per-entry subrequest accounting this is sized against.
const WORKER_FIRST_PASS_BATCH_SIZE = 5

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

  let targetsToProcess: DiaryTarget[] = []
  let remainingScope: DiaryTarget[] = []

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
    const credentials = await assumeS3Credentials(idToken, sessionId, session, env, config)
    const failedTargets: DiaryTarget[] = []
    let processed = 0

    for (const target of targetsToProcess) {
      try {
        // Already mirrored at this exact Drive version (known from a listing, not
        // a stale guess) — the DO index can confirm that with one internal call
        // instead of the usual Drive-meta + Drive-content + S3 HEAD/PUT/HEAD, so a
        // Resync that mostly rediscovers already-synced entries doesn't re-pay
        // full cost for every one of them.
        if (target.version) {
          const known = await index.getEntry(target.date)
          if (known?.state === 'synced' && known.syncedVersion && isAtLeast(known.syncedVersion, target.version)) {
            processed++
            continue
          }
        }

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
        failedTargets.push(target)
        remainingScope.push(target)
      }
    }

    await index.recordProgress(jobId, 'worker-first-pass', processed, failedTargets.map(t => t.date))

    const isFinished = remainingScope.length === 0 && failedTargets.length === 0
    return { isFinished, remainingScope }
  } catch (e) {
    console.warn('Worker first pass STS/batch execution failed, delegating all to Workflow:', e)
    return { isFinished: false, remainingScope: scope ?? remainingScope }
  }
}
