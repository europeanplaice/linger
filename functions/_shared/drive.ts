import type { Env, SessionData } from './session'
import { invalidateFolderScopedS3Cache, saveSession, SESSION_TTL } from './session'
import { folderNameForOrigin } from '../../src/utils/folderName'
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

export interface DriveFolderCandidate {
  id: string
  name: string
  modifiedTime?: string
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

// Bounds every outbound Drive request (headers *and* body — an AbortSignal cancels
// the whole exchange, unlike racing a wrapper promise around just the fetch() call)
// so a stalled connection can't block a Workers invocation indefinitely (e.g. a
// backfill chunk stuck reading one entry's body, silently killed by the platform's
// CPU/wall-clock limit with no error ever recorded) — instead it fails after this
// long, which the caller can catch and skip past like any other error. Every fetch()
// call site below passes this as `signal`; a fresh one is created per call so each
// retry attempt gets its own full budget.
const DRIVE_FETCH_TIMEOUT_MS = 20_000

async function driveWithRetry<T>(
  fetcher: () => Promise<Response>,
  parse: (r: Response) => Promise<T>,
): Promise<T> {
  const delays = [250, 500, 1000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher()
    if (res.ok) return parse(res)

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

export function getFolderName(sessionDomain?: string): string {
  return folderNameForOrigin(sessionDomain)
}

export interface EnsureFolderOptions {
  // Set only by the account-scoped Durable Object after it has serialized this
  // request. Workflow code must otherwise resolve through the Pages service.
  withinCoordinator?: boolean
  // On first assignment, check Drive even when this session has a cached ID so
  // pre-coordinator sessions cannot silently establish a split account root.
  discoverByName?: boolean
}

export async function ensureFolder(
  token: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  options: EnsureFolderOptions = {},
): Promise<string> {
  if (!options.withinCoordinator) {
    if (!session.user_id) throw new DriveError(401, 'Google account identity missing; sign in again')

    // Route even a cached session through the account-level pointer. A cached
    // ID is a hint from this login session, not the account-wide source of truth.
    let folderId: string
    if (env.S3_WORKFLOW_SERVICE) {
      folderId = await env.S3_WORKFLOW_SERVICE.ensureDiaryFolder({
        sessionId,
        accountKey: session.user_id,
        vaultKey: session.vault_key,
        accessToken: token,
        expiresAt: session.expires_at ?? 0,
        idToken: session.id_token,
      })
    } else if (env.DIARY_WRITER) {
      folderId = await env.DIARY_WRITER.getByName(session.user_id).ensureFolder({
        sessionId,
        accountKey: session.user_id,
        vaultKey: session.vault_key,
        accessToken: token,
        expiresAt: session.expires_at ?? 0,
        idToken: session.id_token,
      })
    } else {
      throw new DriveError(503, 'Account folder coordinator unavailable')
    }
    if (session.folder_id !== folderId) invalidateFolderScopedS3Cache(session)
    session.folder_id = folderId
    return folderId
  }

  if (session.folder_id && !options.discoverByName) return session.folder_id

  const folderName = getFolderName(env.SESSION_DOMAIN)
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`)
  const folders: { id: string }[] = []
  let pageToken: string | undefined
  do {
    const pageUrl = `${BASE}/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=2${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const page = await driveWithRetry(
      () => fetch(pageUrl, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
      r => r.json() as Promise<{ files: { id: string }[]; nextPageToken?: string }>,
    )
    folders.push(...page.files)
    if (folders.length > 1) {
      throw new DriveError(409, `Multiple Drive folders named "${folderName}" need to be resolved`)
    }
    // Drive can return a short or empty page before the end of the listing.
    // A continuation token alone does not prove that another folder exists.
    pageToken = page.nextPageToken
  } while (pageToken)

  let folderId: string
  if (folders.length > 0) {
    folderId = folders[0].id
    if (session.folder_id && session.folder_id !== folderId) {
      throw new DriveError(409, 'This session points to a different diary folder; resolve the folders before syncing')
    }
  } else if (session.folder_id) {
    // The user may have renamed or moved the cached folder. Keep using the
    // validated account pointer rather than create a second diary folder.
    folderId = session.folder_id
  } else {
    const created = await driveWithRetry(
      () => fetch(`${BASE}/files`, {
        method: 'POST',
        headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
      }),
      r => r.json() as Promise<{ id: string }>,
    )
    folderId = created.id
  }

  if (session.folder_id !== folderId) invalidateFolderScopedS3Cache(session)
  const updated = { ...session, folder_id: folderId }
  await saveSession(sessionId, updated, env)
  session.folder_id = folderId
  return folderId
}

/** List folders this app can currently see for the authenticated Google account. */
export async function listDriveFolders(token: string): Promise<DriveFolderCandidate[]> {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false")
  const folders: DriveFolderCandidate[] = []
  let pageToken: string | undefined
  do {
    const pageUrl = `${BASE}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,trashed)&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const page = await driveWithRetry(
      () => fetch(pageUrl, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
      r => r.json() as Promise<{ files: DriveFileMeta[]; nextPageToken?: string }>,
    )
    for (const file of page.files) {
      if (file.id && typeof file.name === 'string' && file.mimeType === 'application/vnd.google-apps.folder' && !file.trashed) {
        folders.push({ id: file.id, name: file.name, ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}) })
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return folders.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

async function withFolderFallback<T>(
  token: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  op: (folderId: string) => Promise<T>,
  folderOptions?: EnsureFolderOptions,
): Promise<T> {
  const folderId = await ensureFolder(token, sessionId, session, env, folderOptions)
  try {
    return await op(folderId)
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      session.folder_id = undefined
      const freshId = await ensureFolder(token, sessionId, session, env, folderOptions)
      return op(freshId)
    }
    console.error('drive.ts: withFolderFallback failed')
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
      () => fetch(url, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
      r => r.json() as Promise<{ files: DriveFileMeta[]; nextPageToken?: string }>,
    )
    if (res.files) files.push(...res.files)
    pageToken = res.nextPageToken
  } while (pageToken)
  return files
}

export async function listEntries(token: string, sessionId: string, session: SessionData, env: Env, folderOptions?: EnsureFolderOptions): Promise<DriveFileMeta[]> {
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain'`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)')
    return listAllFiles(token, `${BASE}/files?q=${q}&fields=${fields}&orderBy=name&pageSize=${FILES_PAGE_SIZE}`)
  }, folderOptions)
}

// Workflow backfills use this page-sized variant so no complete Drive listing is
// persisted in a Workflow step result. The normal Pages API continues to use
// listEntries(), which intentionally returns the full list for its existing callers.
export async function listEntryPage(
  token: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  pageToken?: string,
  folderOptions?: EnsureFolderOptions,
): Promise<{ files: DriveFileMeta[]; nextPageToken?: string }> {
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain'`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)')
    const cursor = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    return driveWithRetry(
      () => fetch(`${BASE}/files?q=${q}&fields=${fields}&orderBy=name&pageSize=${FILES_PAGE_SIZE}${cursor}`, {
        headers: driveHeaders(token),
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
      }),
      r => r.json() as Promise<{ files: DriveFileMeta[]; nextPageToken?: string }>,
    )
  }, folderOptions)
}

export async function searchEntries(token: string, sessionId: string, session: SessionData, env: Env, query: string, folderOptions?: EnsureFolderOptions): Promise<DriveFileMeta[]> {
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain' and fullText contains '${escapedQuery}'`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)')
    return listAllFiles(token, `${BASE}/files?q=${q}&fields=${fields}&pageSize=${FILES_PAGE_SIZE}`)
  }, folderOptions)
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
    () => fetch(`${BASE}/changes/startPageToken?supportsAllDrives=false`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
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
      () => fetch(url, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
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

export async function findEntryMeta(token: string, sessionId: string, session: SessionData, env: Env, date: string, folderOptions?: EnsureFolderOptions): Promise<DriveFileMeta | null> {
  // `date` is validated as YYYY-MM-DD by the calling endpoint, so it is safe to
  // interpolate directly. Accept both the legacy `.md` and current `.txt` names.
  return withFolderFallback(token, sessionId, session, env, async folderId => {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and (name='diary-${date}.md' or name='diary-${date}.txt')`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version,mimeType,parents,trashed)')
    const res = await driveWithRetry(
      () => fetch(`${BASE}/files?q=${q}&fields=${fields}&pageSize=2`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
      r => r.json() as Promise<{ files: DriveFileMeta[]; nextPageToken?: string }>,
    )
    // A legacy .md and a .txt (or two same-named files) must never be resolved
    // by arbitrary list order. Leave both untouched until the user resolves it.
    if (res.files.length > 1 || res.nextPageToken) throw new DriveError(409, 'Multiple diary files exist for this date')
    const meta = res.files[0]
    if (meta && !isExpectedDiaryFile(meta, folderId, date)) throw new DriveError(409, 'Diary file metadata does not match the requested date and folder')
    return meta ?? null
  }, folderOptions)
}

export async function getEntryMeta(token: string, fileId: string): Promise<DriveFileMeta> {
  const fields = encodeURIComponent('id,name,modifiedTime,version,mimeType,parents,trashed')
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?fields=${fields}`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
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
  folderOptions?: EnsureFolderOptions,
): Promise<DriveFileMeta> {
  const [folderId, meta] = await Promise.all([
    ensureFolder(token, sessionId, session, env, folderOptions),
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
    const fmDate = frontmatter.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? ''
    // Ordinary Markdown separators are diary text, not a legacy file header.
    if (/^\d{4}-\d{2}-\d{2}$/.test(fmDate)) {
      const content = match[2].replace(/^\r?\n/, '')
      return { date: date || fmDate, content }
    }
  }
  return { date, content: text }
}

export async function getEntryContent(token: string, fileId: string, date: string): Promise<DiaryEntry> {
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?alt=media`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
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
  createFileId?: string,
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
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
      }),
      r => r.json() as Promise<DriveFileMeta>,
    )
  }

  const filename = `diary-${entry.date}.txt`
  if (!folderId) throw new Error('folderId is required when creating a new entry')
  const { contentType, data } = buildMultipart({ name: filename, mimeType: 'text/plain', parents: [folderId], ...(createFileId ? { id: createFileId } : {}) }, body)
  return driveWithRetry(
    () => fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=${fields}`, {
      method: 'POST',
      headers: driveHeaders(token, { 'Content-Type': contentType }),
      body: data,
      signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
    }),
    r => r.json() as Promise<DriveFileMeta>,
  )
}

// One-time migration: rename legacy `diary-YYYY-MM-DD.md` files to `.txt`.
// Idempotent — returns [] once no `.md` files remain. fileId/version change but
// content (and revision history) are preserved by the metadata-only PATCH.
// Returns the dates that were renamed: the version bump from the rename leaves
// any S3 mirror of these dates stamped with a now-stale version (see s3.ts's
// isAtLeast), so callers must re-mirror them or their sync status gets stuck
// reporting "pending" forever — see migrate.ts.
export async function migrateMdToTxt(token: string, sessionId: string, session: SessionData, env: Env): Promise<string[]> {
  const files = await listEntries(token, sessionId, session, env)
  const legacy = files
    .map(f => ({ file: f, date: f.name.match(/^diary-(\d{4}-\d{2}-\d{2})\.md$/)?.[1] }))
    .filter((e): e is { file: DriveFileMeta; date: string } => !!e.date)
  const fields = encodeURIComponent('id')
  for (const { file, date } of legacy) {
    const name = `diary-${date}.txt`
    await driveWithRetry(
      () => fetch(`${BASE}/files/${file.id}?fields=${fields}`, {
        method: 'PATCH',
        headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
      }),
      r => r.json() as Promise<{ id: string }>,
    )
  }
  return legacy.map(e => e.date)
}

export async function generateFileId(token: string): Promise<string> {
  const result = await driveWithRetry(
    () => fetch(`${BASE}/files/generateIds?count=1&space=drive&type=files`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
    r => r.json() as Promise<{ ids: string[] }>,
  )
  if (!result.ids?.[0]) throw new Error('Drive did not return a file ID')
  return result.ids[0]
}

// User deletions remain recoverable from Google Drive's trash.
export async function trashEntry(token: string, fileId: string): Promise<void> {
  await driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}`, {
      method: 'PATCH', headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ trashed: true }), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
    }),
    () => Promise.resolve(),
  )
}

export async function listRevisions(token: string, fileId: string): Promise<DriveRevisionMeta[]> {
  const fields = encodeURIComponent('revisions(id,modifiedTime,size)')
  const res = await driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}/revisions?fields=${fields}`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
    r => r.json() as Promise<{ revisions: DriveRevisionMeta[] }>,
  )
  return (res.revisions ?? []).slice().reverse()
}

export async function getRevisionContent(token: string, fileId: string, revisionId: string): Promise<DiaryEntry> {
  // The date is not available here; old revisions carry it in frontmatter and
  // new revisions have none. An empty date is acceptable for revision display.
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}/revisions/${revisionId}?alt=media`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
    async r => parseEntry(await r.text(), ''),
  )
}

export async function readJsonFile<T>(token: string, fileId: string): Promise<T> {
  return driveWithRetry(
    () => fetch(`${BASE}/files/${fileId}?alt=media`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
    async r => JSON.parse(await r.text()) as T,
  )
}

export async function findJsonFile(token: string, folderId: string, fileName: string): Promise<string | null> {
  const escapedName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = encodeURIComponent(`name='${escapedName}' and '${folderId}' in parents and trashed=false`)
  const fields = encodeURIComponent('files(id)')
  const res = await driveWithRetry(
    () => fetch(`${BASE}/files?q=${q}&fields=${fields}&pageSize=1`, { headers: driveHeaders(token), signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS) }),
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
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
    }),
    r => r.json() as Promise<DriveFileMeta>,
  )
}

// Re-export SESSION_TTL for route handlers that update the session
export { SESSION_TTL }
