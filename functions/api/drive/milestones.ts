import type { Env, Data } from '../../_shared/session'
import { jsonResponse, saveSession } from '../../_shared/session'
import { DriveError, ensureFolder, findJsonFiles, readJsonFile, writeJsonFile, trashEntry } from '../../_shared/drive'

const FILE_NAME = 'milestones.json'
const LEGACY_FILE_NAME = 'anniversaries.json'
const MAX_MILESTONES = 50
const MAX_MILESTONE_BADGES = 5
const MAX_LABEL_LENGTH = 100

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  const persistSession = () => {
    const saving = saveSession(sessionId, { ...session }, context.env).catch(() => {
      console.error('milestones.ts: Failed to persist milestones file id')
    })
    if (typeof context.waitUntil === 'function') context.waitUntil(saving)
  }

  try {
    let cachedCleared = false
    if (session.milestones_file_id) {
      try {
        const data = await readJsonFile<unknown>(accessToken, session.milestones_file_id)
        if (!Array.isArray(data)) return jsonResponse([])
        return jsonResponse(data)
      } catch (e) {
        if (e instanceof SyntaxError) {
          console.warn('milestones.ts: corrupted JSON, returning [] so next PUT can heal')
          return jsonResponse([])
        }
        if (e instanceof DriveError && e.status === 404) {
          session.milestones_file_id = undefined
          cachedCleared = true
        } else {
          throw e
        }
      }
    }

    const folderId = await ensureFolder(accessToken, sessionId, session, context.env, { allowCached: true })
    const found = await findJsonFiles(accessToken, folderId, [FILE_NAME, LEGACY_FILE_NAME])
    const fileId = found[FILE_NAME] ?? found[LEGACY_FILE_NAME] ?? null
    if (!fileId) {
      if (cachedCleared) persistSession()
      return jsonResponse([])
    }
    if (found[FILE_NAME] && session.milestones_file_id !== found[FILE_NAME]) {
      session.milestones_file_id = found[FILE_NAME]
      persistSession()
    } else if (cachedCleared) {
      persistSession()
    }

    let data: unknown
    try {
      data = await readJsonFile<unknown>(accessToken, fileId)
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.warn('milestones.ts: corrupted JSON, returning [] so next PUT can heal')
        return jsonResponse([])
      }
      throw e
    }
    if (!Array.isArray(data)) return jsonResponse([])
    return jsonResponse(data)
  } catch (e) {
    console.error('milestones.ts: GET failed')
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
  if (body.length > MAX_MILESTONES) {
    return jsonResponse({ error: `At most ${MAX_MILESTONES} milestones are allowed` }, 400)
  }

  let enabledBadges = 0
  const sanitized: { id: string; label: string; date: string; showBadge?: boolean; emoji?: string; recurring?: boolean }[] = []

  for (const item of body) {
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.date !== 'string') {
      return jsonResponse({ error: 'Invalid milestone entry' }, 400)
    }
    if (item.showBadge !== undefined && typeof item.showBadge !== 'boolean') {
      return jsonResponse({ error: 'Invalid showBadge value' }, 400)
    }
    if (item.emoji !== undefined && typeof item.emoji !== 'string') {
      return jsonResponse({ error: 'Invalid emoji value' }, 400)
    }
    if (item.recurring !== undefined && typeof item.recurring !== 'boolean') {
      return jsonResponse({ error: 'Invalid recurring value' }, 400)
    }

    const id = item.id.trim()
    if (!id) {
      return jsonResponse({ error: 'Milestone id must not be empty' }, 400)
    }

    const label = item.label.trim()
    if (!label) {
      return jsonResponse({ error: 'Milestone label must not be empty' }, 400)
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return jsonResponse({ error: `Label must be at most ${MAX_LABEL_LENGTH} characters` }, 400)
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      return jsonResponse({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400)
    }
    const [y, m, d] = item.date.split('-').map(Number)
    const parsed = new Date(y, m - 1, d)
    if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
      return jsonResponse({ error: 'Invalid date' }, 400)
    }

    if (item.showBadge !== false) enabledBadges += 1
    sanitized.push({
      id,
      label,
      date: item.date,
      ...(item.showBadge === undefined ? {} : { showBadge: item.showBadge }),
      ...(item.emoji === undefined ? {} : { emoji: item.emoji }),
      ...(item.recurring === undefined ? {} : { recurring: item.recurring }),
    })
  }
  if (enabledBadges > MAX_MILESTONE_BADGES) {
    return jsonResponse({ error: `At most ${MAX_MILESTONE_BADGES} milestone badges can be enabled` }, 400)
  }

  const persistSession = () => {
    const saving = saveSession(sessionId, { ...session }, context.env).catch(() => {
      console.error('milestones.ts: Failed to persist milestones file id')
    })
    if (typeof context.waitUntil === 'function') context.waitUntil(saving)
  }

  try {
    const usedCachedFolder = Boolean(session.folder_id)
    let folderId = await ensureFolder(accessToken, sessionId, session, context.env, { allowCached: true })

    if (session.milestones_file_id) {
      try {
        const meta = await writeJsonFile(accessToken, folderId, FILE_NAME, sanitized, session.milestones_file_id)
        return jsonResponse(meta)
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) {
          session.milestones_file_id = undefined
        } else {
          throw e
        }
      }
    }

    const writeWithDiscovery = async (targetFolderId: string) => {
      const found = await findJsonFiles(accessToken, targetFolderId, [FILE_NAME, LEGACY_FILE_NAME])
      const existingFileId = found[FILE_NAME]
      const meta = await writeJsonFile(accessToken, targetFolderId, FILE_NAME, sanitized, existingFileId)

      // Only trash the legacy file after the replacement was written successfully.
      if (!existingFileId && found[LEGACY_FILE_NAME]) {
        await trashEntry(accessToken, found[LEGACY_FILE_NAME])
      }
      return meta
    }

    let meta
    try {
      meta = await writeWithDiscovery(folderId)
    } catch (e) {
      if (usedCachedFolder && e instanceof DriveError && e.status === 404) {
        session.folder_id = undefined
        folderId = await ensureFolder(accessToken, sessionId, session, context.env, { allowCached: false })
        meta = await writeWithDiscovery(folderId)
      } else {
        throw e
      }
    }

    if (session.milestones_file_id !== meta.id) {
      session.milestones_file_id = meta.id
      persistSession()
    }

    return jsonResponse(meta)
  } catch (e) {
    console.error('milestones.ts: PUT failed')
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
