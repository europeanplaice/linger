import type { SessionData } from '../../../functions/_shared/session'
import {
  findEntryMeta,
  getEntryContent,
  listEntryPage,
} from '../../../functions/_shared/drive'
import { putObjectIfNewer, isAtLeast } from '../../../functions/_shared/s3'
import type { S3Config } from './runtime'
import { assumeS3Credentials, convergeMirror, entryKey, indexFor } from './runtime'
import type { DiaryTarget, WorkflowEnv } from './types'

export interface FirstPassResult {
  isFinished: boolean
  remainingScope: DiaryTarget[]
}

// Sized for a single plain Worker invocation (no chunk reset like the Workflow path
// gets) that also has to fit loadS3Config's Drive calls, token refresh, and the STS
// assume-role in the *same* 50-subrequest Free-plan budget as this batch — see
// workflow.ts's WORKFLOW_CHUNK_SIZE comment for the per-entry subrequest accounting
// this is sized against: 3 per entry (Drive content + S3 HEAD + a conditional PUT —
// the HEAD-guarded update path is always used, never the bare If-None-Match create,
// for the duplicate-version reason explained there), so 10 entries cap the batch at
// ~30. The caller's startBackfill has already spent loadS3Config's Drive reads plus
// up to two Google token-endpoint refreshes in this same budget before this runs, so
// the realistic worst case sits closer to ~36/50 — still under budget, but with less
// slack than the per-entry arithmetic alone suggests.
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
    const credentials = await assumeS3Credentials(idToken, sessionId, session, env, config)
    const failedTargets: DiaryTarget[] = []
    let processed = 0

    for (const target of targetsToProcess) {
      try {
        // Already mirrored at this exact Drive version (known from a listing, not
        // a stale guess) — the DO index can confirm that with one internal call
        // instead of any Drive/S3 subrequest, so a Resync that mostly rediscovers
        // already-synced entries doesn't re-pay cost for every one of them. (A
        // Resync wipes the index precisely so this can't skip — every entry is then
        // re-verified against the bucket by the HEAD-guarded write below instead.)
        const known = await index.getEntry(target.date)
        if (target.version) {
          if (known?.state === 'synced' && known.syncedVersion && isAtLeast(known.syncedVersion, target.version)) {
            processed++
            continue
          }
        }

        // Listing-derived targets (fileId + version known) skip the Drive metadata
        // round-trip — the content fetch below still catches a mid-run deletion
        // (404), and a newer Drive version is caught by the next listing/resync,
        // since putObjectIfNewer's conditional write stamps only what we know.
        const meta = target.fileId
          ? { id: target.fileId, version: target.version }
          : await findEntryMeta(accessToken, sessionId, session, env, target.date)

        if (!meta) {
          await index.markDeleted(target.date)
          processed++
          continue
        }

        const version = meta.version ?? target.version
        // A concurrent save may have bumped the index past this listing-derived hint
        // (markPending's monotonic guard refuses a regression and returns the newer
        // record). Mirror at the newest so a stale stamp can never become the
        // bucket's "current" object under versioning.
        const pending = await index.markPending(target.date, version, new Date().toISOString())
        const mirrorVersion = pending?.driveVersion && version && pending.driveVersion !== version && isAtLeast(pending.driveVersion, version)
          ? pending.driveVersion
          : version
        const { content } = await getEntryContent(accessToken, meta.id, target.date)
        // Always the HEAD-guarded update path — see the note at the write in
        // workflow.ts's processBatch for why the bare If-None-Match create path is
        // never taken: under bucket versioning it would append a duplicate version
        // of every entry after a Resync's index wipe.
        await putObjectIfNewer(credentials, config.bucket, config.region, entryKey(target.date), content, mirrorVersion, undefined, { expectExisting: true })
        const synced = await index.markSynced(target.date, mirrorVersion, new Date().toISOString())
        // Narrow-window complement: a newer save landing between markPending and
        // markSynced leaves a stale "current" object unless we re-mirror at the
        // newest version the index knows.
        if (synced?.driveVersion && mirrorVersion && synced.driveVersion !== mirrorVersion && isAtLeast(synced.driveVersion, mirrorVersion)) {
          await convergeMirror(accessToken, index, config, credentials, target.date, meta.id, mirrorVersion)
        }
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
