import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile } from '../../_shared/drive'
import { S3_SETTINGS_FILE_NAME, isValidS3Settings, backfillAllEntries } from '../../_shared/s3Settings'

// Re-mirrors every existing entry against S3 (backfillAllEntries with no `onlyDates`
// filter) — putObjectIfNewer skips anything already at least as new as Drive, so this is
// safe to run any time, not just once. Triggered by the "Resync all" button in Settings.
// Unlike backfill-retry, this also catches individual per-save mirror misses (e.g. a
// dropped Google id_token on refresh) that never made it into backfillProgress.failed,
// since those only ever get recorded — and thus become retryable — by a backfill run.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const fileId = await findJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME)
    if (!fileId) return jsonResponse({ error: 'S3 backup is not configured' }, 400)

    const settings = await readJsonFile<unknown>(accessToken, fileId)
    if (!isValidS3Settings(settings) || !settings.enabled) {
      return jsonResponse({ error: 'S3 backup is not enabled' }, 400)
    }

    context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, settings, folderId, fileId, undefined, 'Resync'))
    return jsonResponse({ ok: true })
  } catch (e) {
    console.error('s3/resync.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
