import type { Env, Data } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'
import { listRevisions, getDiaryFileMeta, describeDriveError, DriveError } from '../../../_shared/drive'

export const onRequestGet: PagesFunction<Env, 'fileId', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const fileId = context.params.fileId as string
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(fileId)) return jsonResponse({ error: 'Invalid file ID' }, 400)
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    await getDiaryFileMeta(accessToken, sessionId, session, context.env, fileId)
    const revisions = await listRevisions(accessToken, fileId)
    return jsonResponse(revisions)
  } catch (e) {
    if (e instanceof DriveError) return jsonResponse({ error: describeDriveError(e) }, e.status)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}
