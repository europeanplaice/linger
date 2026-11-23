import type { Env, Data } from '../../../../_shared/session'
import { jsonResponse } from '../../../../_shared/session'
import { getRevisionContent, getDiaryFileMeta, DriveError } from '../../../../_shared/drive'

export const onRequestGet: PagesFunction<Env, 'fileId' | 'revisionId', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const fileId = context.params.fileId as string
  const revisionId = context.params.revisionId as string
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(fileId)) return jsonResponse({ error: 'Invalid file ID' }, 400)
  if (!/^[a-zA-Z0-9_-]{1,}$/.test(revisionId)) return jsonResponse({ error: 'Invalid revision ID' }, 400)
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    await getDiaryFileMeta(accessToken, sessionId, session, context.env, fileId)
    if (new URL(context.request.url).searchParams.get('metadata') === '1') return jsonResponse({ ok: true })
    const entry = await getRevisionContent(accessToken, fileId, revisionId)
    return jsonResponse(entry)
  } catch (e) {
    if (e instanceof DriveError) return jsonResponse({ error: e.message }, e.status)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}
