import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile } from '../../_shared/drive'
import { S3_SETTINGS_FILE_NAME, isValidS3Settings, backfillAllEntries } from '../../_shared/s3Settings'

// Re-runs the initial backfill for just the dates it failed on last time (see
// backfillAllEntries's `onlyDates` param) — triggered by the "Retry" button
// SettingsModal shows next to the failed-entries list.
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

    const failed = settings.backfillProgress?.failed ?? []
    if (failed.length === 0) return jsonResponse({ error: 'No failed entries to retry' }, 400)

    context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, settings, folderId, fileId, failed))
    return jsonResponse({ ok: true, retrying: failed.length })
  } catch (e) {
    console.error('s3/backfill-retry.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
