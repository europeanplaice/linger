import type { Env, Data } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile } from '../../../_shared/drive'
import { S3_SETTINGS_FILE_NAME, isValidS3Settings, resyncSingleEntry } from '../../../_shared/s3Settings'

// Re-mirrors a single date against S3 — triggered by the "retry" affordance on an
// entry's sync badge once entry-status has given up waiting and reported
// 'unconfirmed'/'failed' (nothing else is going to attempt this date on its own).
// Uses resyncSingleEntry rather than backfillAllEntries: this can run at any moment,
// including while a real chunked backfill/resync is mid-flight, and must never be
// able to touch that run's total/done/remaining/finishedAt bookkeeping (see
// resyncSingleEntry's own comment for the regression this replaced).
//
// Unlike backfill-retry.ts/resync.ts (which can cover hundreds of entries and are
// fired via context.waitUntil so a slow account doesn't blow the request's wall-
// clock budget), a single date is small enough to just await directly — giving the
// caller an authoritative result immediately instead of another round of polling
// to find out whether the retry itself landed.
export const onRequestPost: PagesFunction<Env, 'date', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const fileId = await findJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME)
    if (!fileId) return jsonResponse({ error: 'S3 backup is not configured' }, 400)

    const settings = await readJsonFile<unknown>(accessToken, fileId)
    if (!isValidS3Settings(settings) || !settings.enabled) {
      return jsonResponse({ error: 'S3 backup is not enabled' }, 400)
    }

    await resyncSingleEntry(accessToken, sessionId, session, context.env, settings, folderId, fileId, date)
    return jsonResponse({ ok: true })
  } catch (e) {
    console.error('s3/entry-resync.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
