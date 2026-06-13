import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile } from '../../_shared/drive'

const FILE_NAME = 'anniversaries.json'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const fileId = await findJsonFile(accessToken, folderId, FILE_NAME)
    if (!fileId) return jsonResponse([])
    const data = await readJsonFile<unknown>(accessToken, fileId)
    return jsonResponse(data)
  } catch (e) {
    console.error('anniversaries.ts: GET failed', e)
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

  if (!Array.isArray(body)) {
    return jsonResponse({ error: 'Expected an array' }, 400)
  }

  for (const item of body) {
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.date !== 'string') {
      return jsonResponse({ error: 'Invalid anniversary entry' }, 400)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      return jsonResponse({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400)
    }
    const [y, m, d] = item.date.split('-').map(Number)
    const parsed = new Date(y, m - 1, d)
    if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
      return jsonResponse({ error: 'Invalid date' }, 400)
    }
  }

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const existingFileId = await findJsonFile(accessToken, folderId, FILE_NAME) ?? undefined
    const meta = await writeJsonFile(accessToken, folderId, FILE_NAME, body, existingFileId)
    return jsonResponse(meta)
  } catch (e) {
    console.error('anniversaries.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
