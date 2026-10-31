import type { Env, Data } from './session'
import { jsonResponse } from './session'
import {
  findEntryMeta,
  getEntryContent,
  saveEntry,
  trashEntry,
  ensureFolder,
  getDiaryFileMeta,
  DriveError,
  DriveConflictError,
} from './drive'
import type { DiaryEntry, DriveFileMeta } from './drive'
import { mirrorEntrySave, mirrorEntryDelete } from './s3Settings'

// Called only by the account-scoped DiaryWriter while holding its mutation queue.
export interface EntryMutationContext {
  request: Request
  params: { date: string }
  data: Data
  env: Env
  waitUntil: (promise: Promise<unknown>) => void
  findEntry?: () => Promise<DriveFileMeta | null>
  createEntry?: (entry: DiaryEntry, folderId: string) => Promise<DriveFileMeta>
  onSaved?: (meta: DriveFileMeta) => Promise<unknown>
  onRemoved?: () => Promise<unknown>
}

const MAX_ENTRY_CONTENT_LENGTH = 500_000
const MAX_ENTRY_BODY_BYTES = 1_000_000

type SaveRequestBody = {
  content: string
  fileId?: string
  baseVersion?: string | null
  baseContent?: string | null
  force?: boolean
}

export async function saveDiaryEntry(context: EntryMutationContext): Promise<Response> {
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

  if (!body || typeof body.content !== 'string') return jsonResponse({ error: 'content is required' }, 400)
  if (body.fileId !== undefined && (typeof body.fileId !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(body.fileId))) {
    return jsonResponse({ error: 'Invalid file ID' }, 400)
  }
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
      const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
      // Force only overrides conflict detection, never file authorization.
      let currentMeta: DriveFileMeta
      try {
        currentMeta = await getDiaryFileMeta(accessToken, sessionId, session, context.env, body.fileId, date)
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return jsonResponse({ conflict: null }, 409)
        throw e
      }
      if (!body.force) {
        if (!currentMeta.version || !body.baseVersion || currentMeta.version !== body.baseVersion) {
          const remoteEntry = await getEntryContent(accessToken, currentMeta.id, date)
          if (body.baseContent == null || remoteEntry.content !== body.baseContent) {
            return jsonResponse({ conflict: { entry: remoteEntry, meta: currentMeta } }, 409)
          }
        }
      }
      try {
        const savedMeta = await saveEntry(accessToken, entry, folderId, currentMeta.id)
        context.waitUntil(context.onSaved?.(savedMeta) ?? mirrorEntrySave(accessToken, sessionId, session, context.env, date, body.content, savedMeta.id, savedMeta.version))
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
          const remoteEntry = await getEntryContent(accessToken, meta.id, date)
          if (body.baseContent != null && remoteEntry.content === body.baseContent) {
            // Content is identical despite the version bump — safe to overwrite
            const savedMeta = await saveEntry(accessToken, entry, folderId, meta.id)
            context.waitUntil(context.onSaved?.(savedMeta) ?? mirrorEntrySave(accessToken, sessionId, session, context.env, date, body.content, savedMeta.id, savedMeta.version))
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
    const meta = await (context.findEntry?.() ?? findEntryMeta(accessToken, sessionId, session, context.env, date))
    const fileId = meta?.id
    if (!meta && !body.force && body.baseVersion != null) return jsonResponse({ conflict: null }, 409)

    // A caller that observed absence must not use an old file ID to update a
    // different/recreated file discovered by date, even if its text is identical.
    if (meta && body.fileId && body.fileId !== meta.id) {
      const remoteEntry = await getEntryContent(accessToken, meta.id, date)
      return jsonResponse({ conflict: { entry: remoteEntry, meta } }, 409)
    }
    if (meta && !body.force && (!meta.version || !body.baseVersion || meta.version !== body.baseVersion)) {
      const remoteEntry = await getEntryContent(accessToken, meta.id, date)
      if (body.baseContent == null || remoteEntry.content !== body.baseContent) {
        return jsonResponse({ conflict: { entry: remoteEntry, meta } }, 409)
      }
    }

    const savedMeta = !fileId && context.createEntry
      ? await context.createEntry(entry, folderId)
      : await saveEntry(accessToken, entry, folderId, fileId)
    context.waitUntil(context.onSaved?.(savedMeta) ?? mirrorEntrySave(accessToken, sessionId, session, context.env, date, body.content, savedMeta.id, savedMeta.version))
    return jsonResponse(savedMeta)
  } catch (e) {
    if (e instanceof DriveConflictError) {
      const meta = await (context.findEntry?.() ?? findEntryMeta(accessToken, sessionId, session, context.env, date))
      const entry = meta ? await getEntryContent(accessToken, meta.id, date) : null
      return jsonResponse({ conflict: meta && entry ? { entry, meta } : null }, 409)
    }
    if (e instanceof DriveError) return jsonResponse({ error: e.message }, e.status)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}

export async function removeDiaryEntry(context: EntryMutationContext): Promise<Response> {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)

  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const meta = await (context.findEntry?.() ?? findEntryMeta(accessToken, sessionId, session, context.env, date))
    if (!meta) return new Response(null, { status: 204 })

    const fileId = context.request.headers.get('X-Linger-File-Id')
    const baseVersion = context.request.headers.get('If-Match')
    if (!fileId || !baseVersion) return jsonResponse({ error: 'Reload the entry before deleting it' }, 428)
    if (meta.id !== fileId || meta.version !== baseVersion) {
      const entry = await getEntryContent(accessToken, meta.id, date)
      return jsonResponse({ conflict: { entry, meta } }, 409)
    }
    await trashEntry(accessToken, meta.id)
    context.waitUntil(context.onRemoved?.() ?? mirrorEntryDelete(accessToken, sessionId, session, context.env, date))
    return new Response(null, { status: 204 })
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.status === 404) return new Response(null, { status: 204 })
      return jsonResponse({ error: e.message }, e.status)
    }
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}
