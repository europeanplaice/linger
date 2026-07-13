import type { Env, Data } from '../../_shared/session'
import { jsonResponse, saveSession } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile } from '../../_shared/drive'
import { S3_SETTINGS_FILE_NAME, getS3Settings, isValidS3Settings, backfillAllEntries } from '../../_shared/s3Settings'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const settings = await getS3Settings(accessToken, sessionId, session, context.env)
    return jsonResponse(settings)
  } catch (e) {
    console.error('s3/settings.ts: GET failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}

export const onRequestPut: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  if (!isValidS3Settings(body)) {
    return jsonResponse({ error: 'Invalid S3 settings (check Role ARN / bucket / region format)' }, 400)
  }

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const existingFileId = await findJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME) ?? undefined

    let previouslyEnabled = false
    if (existingFileId) {
      try {
        const existing = await readJsonFile<unknown>(accessToken, existingFileId)
        previouslyEnabled = isValidS3Settings(existing) && existing.enabled
      } catch {
        // Corrupt or legacy settings file — treat as not previously enabled.
      }
    }

    const meta = await writeJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME, body, existingFileId)

    if (session.s3_settings_negative_cache_at !== undefined) {
      session.s3_settings_negative_cache_at = undefined
      await saveSession(sessionId, session, context.env)
    }

    // Mirror every existing entry the first time backup is enabled — otherwise only
    // entries saved/deleted after this point would ever reach the bucket.
    if (body.enabled && !previouslyEnabled) {
      context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, body, folderId, meta.id))
    }

    return jsonResponse(meta)
  } catch (e) {
    console.error('s3/settings.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
