import type { Data, Env } from '../../_shared/session'
import { DriveError, inspectDriveFolder, listDriveFolders } from '../../_shared/drive'
import { jsonResponse } from '../../_shared/session'

function folderError(error: unknown): Response {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('FOLDER_READ_ONLY')) return jsonResponse({ error: 'Folder is read-only', code: 'read_only' }, 403)
  if (message.includes('FOLDER_EMPTY')) return jsonResponse({ error: 'Confirm using a folder with no visible diary entries', code: 'empty_folder' }, 422)
  if (message.includes('FOLDER_AUTH_EXPIRED')) return jsonResponse({ error: 'Sign in again' }, 401)
  if (message.includes('FOLDER_PERMISSION_DENIED')) return jsonResponse({ error: 'Access denied', code: 'permission_denied' }, 403)
  if (message.includes('FOLDER_RATE_LIMITED')) return jsonResponse({ error: 'Too many Drive requests', code: 'rate_limited' }, 429)
  const status = error instanceof DriveError ? error.status
    : message.includes('in progress') || message.includes('backfill is already running') || message.includes('writer is busy') ? 409
      : message.includes('not available') || message.includes('FOLDER_UNAVAILABLE') ? 400 : 500
  const code = status === 409 ? 'busy' : status === 403 ? 'permission_denied'
    : status === 400 || status === 404 ? 'unavailable' : status === 429 ? 'rate_limited' : 'failed'
  return jsonResponse({ error: 'Could not access the diary folder', code }, status)
}

export const onRequestGet: PagesFunction<Env, string, Data> = async context => {
  const { accessToken, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  try {
    const folderId = new URL(context.request.url).searchParams.get('folderId')
    if (folderId !== null) {
      if (!folderId || folderId.length > 256) return jsonResponse({ error: 'Invalid folder', code: 'unavailable' }, 400)
      return jsonResponse(await inspectDriveFolder(accessToken, folderId))
    }
    return jsonResponse({ folders: await listDriveFolders(accessToken), selectedFolderId: session.folder_id ?? null })
  } catch (error) {
    console.error('folders.ts: Failed to list Drive folders')
    return folderError(error)
  }
}

export const onRequestPost: PagesFunction<Env, string, Data> = async context => {
  const { accessToken, sessionId, session, idToken } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  const reader = context.request.body?.getReader()
  if (!reader) return jsonResponse({ error: 'Invalid JSON' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>
    try { result = await reader.read() }
    catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
    if (result.done) break
    size += result.value.byteLength
    if (size > 2048) {
      await reader.cancel()
      return jsonResponse({ error: 'Folder selection request is too large' }, 413)
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!body || typeof body !== 'object' || !('folderId' in body) || typeof body.folderId !== 'string' || !body.folderId || body.folderId.length > 256) {
    return jsonResponse({ error: 'A Drive folder must be selected' }, 400)
  }
  const folderId = body.folderId
  if ('allowEmpty' in body && typeof body.allowEmpty !== 'boolean') {
    return jsonResponse({ error: 'Invalid empty folder confirmation' }, 400)
  }

  try {
    const accountKey = session.user_id
    const service = context.env.S3_WORKFLOW_SERVICE
    if (!accountKey || !service) return jsonResponse({ error: 'Folder recovery is temporarily unavailable' }, 503)
    const selectedFolderId = await service.selectDiaryFolder({
      sessionId, accountKey, vaultKey: session.vault_key,
      accessToken, expiresAt: session.expires_at ?? 0, idToken,
      folderId,
      allowEmpty: 'allowEmpty' in body && body.allowEmpty === true,
    })
    return jsonResponse({ selectedFolderId })
  } catch (error) {
    console.error('folders.ts: Failed to select Drive folder')
    return folderError(error)
  }
}
