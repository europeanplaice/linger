import type { Env, SessionData } from './session'
import { saveSession, SESSION_TTL } from './session'

const FOLDER_NAME = 'linger_diary'
const BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

export interface DriveFileMeta {
  id: string
  name: string
  modifiedTime?: string
  version?: string
  mimeType?: string
  parents?: string[]
  trashed?: boolean
}

export interface DiaryEntry {
  date: string
  content: string
}

export interface DriveRevisionMeta {
  id: string
  modifiedTime: string
  size?: string
}

export class DriveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'DriveError'
  }
}

export class DriveConflictError extends Error {
  constructor() {
    super('Version conflict')
    this.name = 'DriveConflictError'
  }
}

function driveHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Cache-Control': 'no-cache',
    'Accept-Encoding': 'gzip',
    'User-Agent': 'linger_diary (gzip)',
    ...extra,
  }
}

async function driveWithRetry<T>(
  fetcher: () => Promise<Response>,
  parse: (r: Response) => Promise<T>,
  accept204 = false,
): Promise<T> {
  const delays = [250, 500, 1000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher()
    if (res.ok || (accept204 && res.status === 204)) return parse(res)

    if (res.status === 412) throw new DriveConflictError()
    const body = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
      let delay = delays[attempt]
      const ra = res.headers.get('Retry-After')
      if (ra) { const s = parseFloat(ra); if (!isNaN(s)) delay = s * 1000 }
      await new Promise(r => setTimeout(r, delay * (1 + 0.2 * (Math.random() * 2 - 1))))
      continue
    }
    throw new DriveError(res.status, body)
  }
}

export function getFolderName(sessionDomain: string): string {
  if (sessionDomain.includes('staging.')) {
    return `${FOLDER_NAME}_staging`
  }
  if (sessionDomain.includes('localhost') || sessionDomain.includes('127.0.0.1')) {
    return `${FOLDER_NAME}_dev`
  }
  return FOLDER_NAME
}

export async function ensureFolder(token: string, sessionId: string, session: SessionData, env: Env): Promise<string> {
  if (session.folder_id) return session.folder_id

  const folderName = getFolderName(env.SESSION_DOMAIN)
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`)
  const list = await driveWithRetry(
    () => fetch(`${BASE}/files?q=${q}&fields=files(id,name)`, { headers: driveHeaders(token) }),
    r => r.json() as Promise<{ files: { id: string }[] }>,
  )

  let folderId: string
  if (list.files.length > 0) {
    folderId = list.files[0].id
  } else {
    const created = await driveWithRetry(
      () => fetch(`${BASE}/files`, {
        method: 'POST',
        headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
      }),
      r => r.json() as Promise<{ id: string }>,
    )
    folderId = created.id
  }

  const updated = { ...session, folder_id: folderId }
  await saveSession(sessionId, updated, env)
  session.folder_id = folderId
  return folderId
}

async function withFolderFallback<T>(
  token: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  op: (folderId: string) => Promise<T>,
): Promise<T> {
  const folderId = await ensureFolder(token, sessionId, session, env)
  try {
    return await op(folderId)
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      session.folder_id = undefined
      const freshId = await ensureFolder(token, sessionId, session, env)
      return op(freshId)
    }
    console.error('drive.ts: withFolderFallback failed', e)
    throw e
  }
}

// Drive API v3 files.list caps pageSize at 100; values above are silently capped.
// We page through nextPageToken to collect every matching file.
const FILES_PAGE_SIZE = 100

async function listAllFiles(token: string, baseUrl: string): Promise<DriveFileMeta[]> {
  const files: DriveFileMeta[] = []
  let pageToken: string | undefined
  do {
    const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl
    const res = await driveWithRetry(
      () => fetch(url, { headers: driveHeaders(token) }),
      r => r.json() as Promise<{ files: DriveFileMeta[]; nextPageToken?: string }>,
    )
    if (res.files) files.push(...res.files)
    pageToken = res.nextPageToken
  } while (pageToken)
  return files
}

export async function listEntries(token: string, sessionId: string, session: SessionData, env: Env): Promise<DriveFileMeta[]> {
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain'`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)')
    return listAllFiles(token, `${BASE}/files?q=${q}&fields=${fields}&orderBy=name&pageSize=${FILES_PAGE_SIZE}`)
  })
}

export async function searchEntries(token: string, sessionId: string, session: SessionData, env: Env, query: string): Promise<DriveFileMeta[]> {
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain' and fullText contains '${escapedQuery}'`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)')
    return listAllFiles(token, `${BASE}/files?q=${q}&fields=${fields}&pageSize=${FILES_PAGE_SIZE}`)
  })
}

export interface DriveChange {
  fileId: string
  removed: boolean
  file?: DriveFileMeta
}

export interface ChangesResult {
  changes: DriveChange[]
  newStartPageToken: string
}

// Gets the initial start page token (used after a full listEntries call).
export async function getStartPageToken(token: string): Promise<string> {
  const res = await driveWithRetry(
    () => fetch(`${BASE}/changes/startPageToken?supportsAllDrives=false`, { headers: driveHeaders(token) }),
    r => r.json() as Promise<{ startPageToken: string }>,
  )
  return res.startPageToken
}

interface RawChange {
  fileId: string
  removed?: boolean
  file?: DriveFileMeta
}

// Gets changes since the stored page token; handles nextPageToken pagination.
export async function getChanges(token: string, pageToken: string): Promise<ChangesResult> {
  const fields = encodeURIComponent('newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,modifiedTime,version,mimeType,parents,trashed))')
  const changes: DriveChange[] = []
  let cursor = pageToken
  let newStartPageToken = pageToken
  for (;;) {
    const url = `${BASE}/changes?pageToken=${encodeURIComponent(cursor)}&spaces=drive&restrictToMyDrive=true&includeRemoved=true&includeItemsFromAllDrives=false&fields=${fields}`
    const res = await driveWithRetry(
      () => fetch(url, { headers: driveHeaders(token) }),
      r => r.json() as Promise<{ changes?: RawChange[]; nextPageToken?: string; newStartPageToken?: string }>,
    )
    for (const c of res.changes ?? []) {
      changes.push({ fileId: c.fileId, removed: c.removed === true, file: c.file })
    }
    if (res.nextPageToken) {
      cursor = res.nextPageToken
      continue
    }
    if (res.newStartPageToken) newStartPageToken = res.newStartPageToken
    break
  }
  return { changes, newStartPageToken }
}

export async function findEntryMeta(token: string, sessionId: string, session: SessionData, env: Env, date: string): Promise<DriveFileMeta | null> {
  // `date` is validated as YYYY-MM-DD by the calling endpoint, so it is safe to
  // interpolate directly. Accept both the legacy `.md` and current `.txt` names.
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and (name='diary-${date}.md' or name='diary-${date}.txt')`)
    const fields = encodeURIComponent('files(id,name,modifiedTime,version)')
    const res = await driveWithRetry(
      () => fetch(`${BASE}/files?q=${q}&fields=${fields}&pageSize=1`, { headers: driveHeaders(token) }),
      r => r.json() as Promise<{ files: DriveFileMeta[] }>,
    )
    return res.files[0] ?? null
  })
}

export async function getEntryMeta(token: string, fileId: string): Promise<DriveFileMeta> {
  const fields = encodeURIComponent('id,name,modifiedTime,version,mimeType,parents,trashed')
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?fields=${fields}`, { headers: driveHeaders(token) }),
    r => r.json() as Promise<DriveFileMeta>,
  )
}

// Both the legacy `.md` and current `.txt` extensions are accepted on read.
// `date` is always a validated YYYY-MM-DD string when provided.
function expectedDiaryName(date?: string): RegExp {
  return date
    ? new RegExp(`^diary-${date}\\.(md|txt)$`)
    : /^diary-\d{4}-\d{2}-\d{2}\.(md|txt)$/
}

function isExpectedDiaryFile(meta: DriveFileMeta, folderId: string, date?: string): boolean {
  const nameMatches = expectedDiaryName(date).test(meta.name)

  return nameMatches
    && meta.mimeType === 'text/plain'
    && meta.trashed !== true
    && Array.isArray(meta.parents)
    && meta.parents.includes(folderId)
}

export async function getDiaryFileMeta(
  token: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  fileId: string,
  date?: string,
): Promise<DriveFileMeta> {
  const [folderId, meta] = await Promise.all([
    ensureFolder(token, sessionId, session, env),
    getEntryMeta(token, fileId),
  ])

  if (!isExpectedDiaryFile(meta, folderId, date)) {
    throw new DriveError(404, 'not_found')
  }

  return meta
}

function serializeEntry(entry: DiaryEntry): string {
  return entry.content
}

// Parses a diary file body. The authoritative date comes from the filename and
// is passed in via `date`. Legacy files carry a `---\ndate: …\n---` frontmatter
// block: when present it is stripped from the body, and its date is used as a
// fallback if no `date` was provided. New files have no frontmatter, so the
// whole text is the body. Never throws.
function parseEntry(text: string, date: string): DiaryEntry {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match) {
    const frontmatter = match[1]
    const content = match[2].replace(/^\n/, '')
    const fmDate = frontmatter.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? ''
    return { date: date || fmDate, content }
  }
  return { date, content: text }
}

export async function getEntryContent(token: string, fileId: string, date: string): Promise<DiaryEntry> {
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?alt=media`, { headers: driveHeaders(token) }),
    async r => parseEntry(await r.text(), date),
  )
}

function buildMultipart(meta: object, body: string, bodyMimeType = 'text/plain; charset=UTF-8'): { contentType: string; data: string } {
  const boundary = 'linger_boundary'
  const parts = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(meta),
    `--${boundary}`,
    `Content-Type: ${bodyMimeType}`,
    '',
    body,
    `--${boundary}--`,
  ].join('\r\n')
  return { contentType: `multipart/related; boundary=${boundary}`, data: parts }
}

export async function saveEntry(
  token: string,
  entry: DiaryEntry,
  folderId: string | null,
  fileId?: string,
  ifMatch?: string | null,
): Promise<DriveFileMeta> {
  const body = serializeEntry(entry)
  const fields = encodeURIComponent('id,name,modifiedTime,version')

  if (fileId) {
    const extra: Record<string, string> = { 'Content-Type': 'text/plain; charset=UTF-8' }
    if (ifMatch != null) extra['If-Match'] = ifMatch
    return driveWithRetry(
      () => fetch(`${UPLOAD_BASE}/files/${fileId}?uploadType=media&fields=${fields}`, {
        method: 'PATCH',
        headers: driveHeaders(token, extra),
        body,
      }),
      r => r.json() as Promise<DriveFileMeta>,
    )
  }

  const filename = `diary-${entry.date}.txt`
  if (!folderId) throw new Error('folderId is required when creating a new entry')
  const { contentType, data } = buildMultipart({ name: filename, mimeType: 'text/plain', parents: [folderId] }, body)
  return driveWithRetry(
    () => fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=${fields}`, {
      method: 'POST',
      headers: driveHeaders(token, { 'Content-Type': contentType }),
      body: data,
    }),
    r => r.json() as Promise<DriveFileMeta>,
  )
}

// One-time migration: rename legacy `diary-YYYY-MM-DD.md` files to `.txt`.
// Idempotent — returns 0 once no `.md` files remain. fileId/version change but
// content (and revision history) are preserved by the metadata-only PATCH.
export async function migrateMdToTxt(token: string, sessionId: string, session: SessionData, env: Env): Promise<number> {
  const files = await listEntries(token, sessionId, session, env)
  const legacy = files.filter(f => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
  const fields = encodeURIComponent('id')
  for (const f of legacy) {
    const name = f.name.replace(/\.md$/, '.txt')
    await driveWithRetry(
      () => fetch(`${BASE}/files/${f.id}?fields=${fields}`, {
        method: 'PATCH',
        headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name }),
      }),
      r => r.json() as Promise<{ id: string }>,
    )
  }
  return legacy.length
}

export async function deleteEntry(token: string, fileId: string): Promise<void> {
  await driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}`, { method: 'DELETE', headers: driveHeaders(token) }),
    () => Promise.resolve(),
    true,
  )
}

export async function listRevisions(token: string, fileId: string): Promise<DriveRevisionMeta[]> {
  const fields = encodeURIComponent('revisions(id,modifiedTime,size)')
  const res = await driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}/revisions?fields=${fields}`, { headers: driveHeaders(token) }),
    r => r.json() as Promise<{ revisions: DriveRevisionMeta[] }>,
  )
  return (res.revisions ?? []).slice().reverse()
}

export async function getRevisionContent(token: string, fileId: string, revisionId: string): Promise<DiaryEntry> {
  // The date is not available here; old revisions carry it in frontmatter and
  // new revisions have none. An empty date is acceptable for revision display.
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}/revisions/${revisionId}?alt=media`, { headers: driveHeaders(token) }),
    async r => parseEntry(await r.text(), ''),
  )
}

export async function readJsonFile<T>(token: string, fileId: string): Promise<T> {
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?alt=media`, { headers: driveHeaders(token) }),
    async r => JSON.parse(await r.text()) as T,
  )
}

export async function findJsonFile(token: string, folderId: string, fileName: string): Promise<string | null> {
  const escapedName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = encodeURIComponent(`name='${escapedName}' and '${folderId}' in parents and trashed=false`)
  const fields = encodeURIComponent('files(id)')
  const res = await driveWithRetry(
    () => fetch(`${BASE}/files?q=${q}&fields=${fields}&pageSize=1`, { headers: driveHeaders(token) }),
    r => r.json() as Promise<{ files?: { id: string }[] }>,
  )
  return res.files?.[0]?.id ?? null
}

export async function writeJsonFile(
  token: string,
  folderId: string,
  fileName: string,
  content: unknown,
  existingFileId?: string,
): Promise<DriveFileMeta> {
  const body = JSON.stringify(content)
  const fields = encodeURIComponent('id,name,modifiedTime,version')

  if (existingFileId) {
    const { contentType, data } = buildMultipart({}, body, 'application/json; charset=UTF-8')
    return driveWithRetry(
      () => fetch(`${UPLOAD_BASE}/files/${existingFileId}?uploadType=multipart&fields=${fields}`, {
        method: 'PATCH',
        headers: driveHeaders(token, { 'Content-Type': contentType }),
        body: data,
      }),
      r => r.json() as Promise<DriveFileMeta>,
    )
  }

  const { contentType, data } = buildMultipart(
    { name: fileName, mimeType: 'application/json', parents: [folderId] },
    body,
    'application/json; charset=UTF-8',
  )
  return driveWithRetry(
    () => fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=${fields}`, {
      method: 'POST',
      headers: driveHeaders(token, { 'Content-Type': contentType }),
      body: data,
    }),
    r => r.json() as Promise<DriveFileMeta>,
  )
}

// Re-export SESSION_TTL for route handlers that update the session
export { SESSION_TTL }
