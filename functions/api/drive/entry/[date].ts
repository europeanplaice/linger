import type { Env, Data } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'
import {
  findEntryMeta,
  getEntryContent,
  saveEntry,
  deleteEntry,
  ensureFolder,
  getDiaryFileMeta,
  DriveError,
  DriveConflictError,
} from '../../../_shared/drive'
import type { DiaryEntry, DriveFileMeta } from '../../../_shared/drive'

const MAX_ENTRY_CONTENT_LENGTH = 500_000
const MAX_ENTRY_BODY_BYTES = 1_000_000

type SaveRequestBody = {
  content: string
  fileId?: string
  baseVersion?: string | null
  baseContent?: string | null
  force?: boolean
}

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

    const entry = await getEntryContent(accessToken, meta.id)
    return jsonResponse({ entry, meta }, 200, meta.version ? { ETag: meta.version } : undefined)
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.status === 404) return jsonResponse({ error: 'not_found' }, 404)
      return jsonResponse({ error: e.message }, e.status)
    }
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}

export const onRequestPost: PagesFunction<Env, 'date', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)

  const contentLength = context.request.headers.get('Content-Length')
  if (contentLength && Number(contentLength) > MAX_ENTRY_BODY_BYTES) {
    return jsonResponse({ error: 'Entry is too large' }, 413)
  }

  let body: SaveRequestBody
  try {
    body = await context.request.json() as SaveRequestBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body.content !== 'string') return jsonResponse({ error: 'content is required' }, 400)
  if (body.content.length > MAX_ENTRY_CONTENT_LENGTH) return jsonResponse({ error: 'Entry is too large' }, 413)
  if (body.baseVersion !== undefined && body.baseVersion !== null && typeof body.baseVersion !== 'string') {
    return jsonResponse({ error: 'Invalid baseVersion' }, 400)
  }
  if (body.baseContent !== undefined && body.baseContent !== null && typeof body.baseContent !== 'string') {
    return jsonResponse({ error: 'Invalid baseContent' }, 400)
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') return jsonResponse({ error: 'Invalid force' }, 400)

  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const entry: DiaryEntry = { date, content: body.content }

    // Known fileId path: avoid filename search, but still validate current Drive
    // metadata before writing because Drive v3 does not document version as an
    // If-Match token.
    if (body.fileId && (body.force || body.baseVersion !== null)) {
      if (!/^[a-zA-Z0-9_-]{10,200}$/.test(body.fileId)) return jsonResponse({ error: 'Invalid file ID' }, 400)
      const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
      let currentMeta: DriveFileMeta | null = null
      if (!body.force && typeof body.baseVersion === 'string') {
        try {
          currentMeta = await getDiaryFileMeta(accessToken, sessionId, session, context.env, body.fileId, date)
        } catch (e) {
          if (e instanceof DriveError && e.status === 404) return jsonResponse({ conflict: null }, 409)
          throw e
        }
        if ((currentMeta.version ?? null) !== body.baseVersion) {
          const remoteEntry = await getEntryContent(accessToken, currentMeta.id)
          if (body.baseContent == null || remoteEntry.content !== body.baseContent) {
            return jsonResponse({ conflict: { entry: remoteEntry, meta: currentMeta } }, 409)
          }
        }
      }
      try {
        const savedMeta = await saveEntry(accessToken, entry, folderId, currentMeta?.id ?? body.fileId)
        return jsonResponse(savedMeta)
      } catch (e) {
        if (e instanceof DriveConflictError) {
          // 412: remote version changed — fetch current state and check for real conflict
          let meta: DriveFileMeta
          try {
            meta = await getDiaryFileMeta(accessToken, sessionId, session, context.env, body.fileId, date)
          } catch (e2) {
            if (e2 instanceof DriveError && e2.status === 404) return jsonResponse({ conflict: null }, 409)
            throw e2
          }
          const remoteEntry = await getEntryContent(accessToken, meta.id)
          if (body.baseContent != null && remoteEntry.content === body.baseContent) {
            // Content is identical despite the version bump — safe to overwrite
            const savedMeta = await saveEntry(accessToken, entry, folderId, meta.id)
            return jsonResponse(savedMeta)
          }
          return jsonResponse({ conflict: { entry: remoteEntry, meta } }, 409)
        }
        if (e instanceof DriveError && e.status === 404) return jsonResponse({ conflict: null }, 409)
        throw e
      }
    }

    // No fileId: search by filename (first save on this device or new entry)
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const hasBaseVersion = Object.prototype.hasOwnProperty.call(body, 'baseVersion')
    const meta = await findEntryMeta(accessToken, sessionId, session, context.env, date)
    const fileId = meta?.id
    if (!meta && hasBaseVersion && !body.force && body.baseVersion != null) return jsonResponse({ conflict: null }, 409)

    if (meta && hasBaseVersion && !body.force && (meta.version ?? null) !== (body.baseVersion ?? null)) {
      const remoteEntry = await getEntryContent(accessToken, meta.id)
      if (body.baseContent == null || remoteEntry.content !== body.baseContent) {
        return jsonResponse({ conflict: { entry: remoteEntry, meta } }, 409)
      }
    }

    const savedMeta = await saveEntry(accessToken, entry, folderId, fileId)
    return jsonResponse(savedMeta)
  } catch (e) {
    if (e instanceof DriveError) return jsonResponse({ error: e.message }, e.status)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}

export const onRequestDelete: PagesFunction<Env, 'date', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)

  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const meta = await findEntryMeta(accessToken, sessionId, session, context.env, date)
    if (!meta) return new Response(null, { status: 204 })

    await deleteEntry(accessToken, meta.id)
    return new Response(null, { status: 204 })
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.status === 404) return new Response(null, { status: 204 })
      return jsonResponse({ error: e.message }, e.status)
    }
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}
