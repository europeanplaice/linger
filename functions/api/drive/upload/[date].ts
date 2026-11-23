import type { Data, Env } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'
import type { DiaryUploadInput } from '../../../_shared/diaryWriter'
import { DIARY_UPLOAD_URL, diaryUploadResponse } from '../../../_shared/diaryWriter'

export const onRequestPost: PagesFunction<Env, 'date', Data> = async ({ request, params, data, env }) => {
  const date = params.date as string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)
  const { session, sessionId, accessToken, idToken } = data
  if (!session?.user_id) return jsonResponse({ error: 'Unauthorized' }, 401)
  const { DIARY_WRITER: writer, S3_WORKFLOW_SERVICE: service } = env
  if (!writer && !service) return jsonResponse({ error: 'Diary writer temporarily unavailable' }, 503)

  const reader = request.body?.getReader()
  if (!reader) return jsonResponse({ error: 'Missing upload instructions' }, 400)
  let body: Record<string, unknown>
  try {
    const buffer = new Uint8Array(2048)
    let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.length > buffer.length) {
        await reader.cancel()
        return jsonResponse({ error: 'Upload instructions are too large' }, 413)
      }
      buffer.set(value, length)
      length += value.length
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(0, length)))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object')
    body = parsed as Record<string, unknown>
  } catch {
    return jsonResponse({ error: 'Invalid upload instructions' }, 400)
  }

  const { action, bytes, operationId, fileId, baseVersion, force } = body
  if (typeof operationId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(operationId)) {
    return jsonResponse({ error: 'Invalid upload ID' }, 400)
  }
  const auth = { date, operationId, sessionId, accountKey: session.user_id,
    accessToken, idToken, expiresAt: session.expires_at ?? 0, vaultKey: session.vault_key }
  let input: DiaryUploadInput
  const fields = Object.keys(body)
  if (action === 'complete' && fields.every(key => ['action', 'operationId'].includes(key))) {
    input = { ...auth, action }
  } else if (action === 'prepare' && typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0 && bytes <= 1_000_000
    && fields.every(key => ['action', 'operationId', 'bytes', 'fileId', 'baseVersion', 'force'].includes(key))
    && (fileId === undefined || (typeof fileId === 'string' && /^[\w-]{10,200}$/.test(fileId)))
    && (baseVersion == null || (typeof baseVersion === 'string' && baseVersion.length <= 64))
    && (force === undefined || typeof force === 'boolean')) {
    input = { ...auth, action, bytes, fileId, baseVersion, force, origin: request.headers.get('Origin') ?? new URL(request.url).origin }
  } else {
    return jsonResponse({ error: 'Invalid upload instructions' }, 400)
  }
  try {
    if (writer) {
      return await writer.getByName(session.user_id).fetch(new Request(DIARY_UPLOAD_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }))
    }
    return diaryUploadResponse(await service!.uploadDiaryEntry(input))
  } catch {
    if (action === 'prepare') console.warn('Diary upload prepare request failed')
    else console.warn('Diary upload complete request failed')
    return jsonResponse({ error: 'Diary writer temporarily unavailable' }, 503)
  }
}
