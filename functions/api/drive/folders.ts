import type { Data, Env } from '../../_shared/session'
import { DriveError, listDriveFolders } from '../../_shared/drive'
import { jsonResponse } from '../../_shared/session'

export const onRequestGet: PagesFunction<Env, string, Data> = async context => {
  const { accessToken, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  try {
    return jsonResponse({ folders: await listDriveFolders(accessToken), selectedFolderId: session.folder_id ?? null })
  } catch (error) {
    console.error('folders.ts: Failed to list Drive folders')
    const status = error instanceof DriveError ? error.status : 500
    return jsonResponse({ error: 'Could not list Google Drive folders' }, status)
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

  try {
    const accountKey = session.user_id
    const service = context.env.S3_WORKFLOW_SERVICE
    if (!accountKey || !service) return jsonResponse({ error: 'Folder recovery is temporarily unavailable' }, 503)
    const selectedFolderId = await service.selectDiaryFolder({
      sessionId, accountKey, vaultKey: session.vault_key,
      accessToken, expiresAt: session.expires_at ?? 0, idToken,
      folderId,
    })
    return jsonResponse({ selectedFolderId })
  } catch (error) {
    console.error('folders.ts: Failed to select Drive folder')
    const status = error instanceof DriveError ? error.status
      : error instanceof Error && (error.message.includes('backfill is already running') || error.message.includes('in progress')) ? 409
        : error instanceof Error && error.message.includes('not available') ? 400
          : 500
    return jsonResponse({ error: status === 409 ? 'Folder selection is blocked while diary or backup work is in progress' : 'Could not select the Google Drive folder' }, status)
  }
}
