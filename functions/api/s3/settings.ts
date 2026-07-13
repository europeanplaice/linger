import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, writeJsonFile } from '../../_shared/drive'
import { S3_SETTINGS_FILE_NAME, getS3Settings, isValidS3Settings } from '../../_shared/s3Settings'

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
    const meta = await writeJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME, body, existingFileId)
    return jsonResponse(meta)
  } catch (e) {
    console.error('s3/settings.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
