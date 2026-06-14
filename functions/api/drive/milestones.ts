import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile, deleteEntry } from '../../_shared/drive'

const FILE_NAME = 'milestones.json'
const LEGACY_FILE_NAME = 'anniversaries.json'
const MAX_MILESTONES = 10
const MAX_MILESTONE_BADGES = 3
const MAX_LABEL_LENGTH = 100

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    let fileId = await findJsonFile(accessToken, folderId, FILE_NAME)
    if (!fileId) {
      // Fall back to the legacy file name written by older versions.
      fileId = await findJsonFile(accessToken, folderId, LEGACY_FILE_NAME)
    }
    if (!fileId) return jsonResponse([])

    let data: unknown
    try {
      data = await readJsonFile<unknown>(accessToken, fileId)
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.warn('milestones.ts: corrupted JSON, returning [] so next PUT can heal', e)
        return jsonResponse([])
      }
      throw e
    }
    if (!Array.isArray(data)) return jsonResponse([])
    return jsonResponse(data)
  } catch (e) {
    console.error('milestones.ts: GET failed', e)
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

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const existingFileId = await findJsonFile(accessToken, folderId, FILE_NAME) ?? undefined
    const meta = await writeJsonFile(accessToken, folderId, FILE_NAME, sanitized, existingFileId)

    // Migrate: delete the legacy anniversaries.json if it still exists.
    if (!existingFileId) {
      const legacyFileId = await findJsonFile(accessToken, folderId, LEGACY_FILE_NAME)
      if (legacyFileId) {
        await deleteEntry(accessToken, legacyFileId)
      }
    }

    return jsonResponse(meta)
  } catch (e) {
    console.error('milestones.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
