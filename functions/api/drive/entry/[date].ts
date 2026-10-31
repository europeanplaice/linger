import type { Env, Data } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'
import { findEntryMeta, getEntryContent, getDiaryFileMeta, DriveError } from '../../../_shared/drive'
import { forwardDiaryMutation } from '../../../_shared/diaryWriter'

export const onRequestGet: PagesFunction<Env, 'date', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)

  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const fileIdParam = new URL(context.request.url).searchParams.get('fileId')
    const trustedFileId = fileIdParam && /^[a-zA-Z0-9_-]{10,60}$/.test(fileIdParam) ? fileIdParam : null

    let meta = null
    if (trustedFileId) {
      try { meta = await getDiaryFileMeta(accessToken, sessionId, session, context.env, trustedFileId, date) } catch (e) {
        if (e instanceof DriveError && e.status === 404) return jsonResponse({ error: 'not_found' }, 404)
        throw e
      }
    } else {
      meta = await findEntryMeta(accessToken, sessionId, session, context.env, date)
    }
    if (!meta) return jsonResponse({ error: 'not_found' }, 404)

    const ifNoneMatch = context.request.headers.get('If-None-Match')
    if (ifNoneMatch && meta.version && ifNoneMatch === meta.version) {
      return new Response(null, { status: 304 })
    }

    const entry = await getEntryContent(accessToken, meta.id, date)
    return jsonResponse({ entry, meta }, 200, meta.version ? { ETag: meta.version } : undefined)
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.status === 404) return jsonResponse({ error: 'not_found' }, 404)
      return jsonResponse({ error: e.message }, e.status)
    }
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}

export const onRequestPost: PagesFunction<Env, 'date', Data> = forwardDiaryMutation
export const onRequestDelete: PagesFunction<Env, 'date', Data> = forwardDiaryMutation
