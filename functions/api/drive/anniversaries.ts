import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, readJsonFile, writeJsonFile } from '../../_shared/drive'

const FILE_NAME = 'anniversaries.json'

async function findAnniversariesFile(token: string, folderId: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${FILE_NAME}' and '${folderId}' in parents and trashed=false`)
  const fields = encodeURIComponent('files(id)')
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const body = await res.json() as { files?: { id: string }[] }
  return body.files?.[0]?.id ?? null
}

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const fileId = await findAnniversariesFile(accessToken, folderId)
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
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.monthDay !== 'string') {
      return jsonResponse({ error: 'Invalid anniversary entry' }, 400)
    }
    if (!/^\d{2}-\d{2}$/.test(item.monthDay)) {
      return jsonResponse({ error: 'Invalid monthDay format' }, 400)
    }
    const [mm, dd] = item.monthDay.split('-').map(Number)
    const parsed = new Date(2000, mm - 1, dd)
    if (parsed.getMonth() !== mm - 1 || parsed.getDate() !== dd) {
      return jsonResponse({ error: 'Invalid date' }, 400)
    }
  }

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const existingFileId = await findAnniversariesFile(accessToken, folderId) ?? undefined
    const meta = await writeJsonFile(accessToken, folderId, FILE_NAME, body, existingFileId)
    return jsonResponse(meta)
  } catch (e) {
    console.error('anniversaries.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
