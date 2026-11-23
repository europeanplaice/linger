import { setVaultKeyHeader } from '../lib/passkeyVault'
import type { ChangesResult, DiaryEntry, DriveChange, DriveFileMeta, LoadedDiaryEntry } from '../types'
import { accountRequest, invalidateAccount } from '../lib/accountSession'
import { getAccessToken, getIdToken } from '../lib/oauthCredentials'
import { parseDriveEntry } from '../utils/parseDriveEntry'

const BASE = '/api/drive'
const GOOGLE_DRIVE = 'https://www.googleapis.com'

export class TokenExpiredError extends Error {
  constructor() {
    super('Session expired')
    this.name = 'TokenExpiredError'
  }
}

export class DriveHttpError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`API ${status}: ${body}`)
    this.name = 'DriveHttpError'
    this.status = status
  }
}

export class SaveConflictError extends Error {
  remote: LoadedDiaryEntry | null

  constructor(remote: LoadedDiaryEntry | null) {
    super('Entry was changed on another device')
    this.name = 'SaveConflictError'
    this.remote = remote
  }
}

interface SaveEntryOptions {
  fileId?: string
  baseVersion?: string | null
  baseContent?: string | null
  force?: boolean
  signal?: AbortSignal
  keepalive?: boolean
}

// Browsers cap fetch({ keepalive: true }) bodies at 64 KiB; leave headroom for
// headers and concurrent keepalive requests.
const KEEPALIVE_MAX_BYTES = 60_000

interface SaveConflictResponse {
  conflict: LoadedDiaryEntry | null
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500
}

function retryDelay(attempt: number): number {
  switch (attempt) {
    case 0:
      return 250
    case 1:
      return 500
    default:
      return 1000
  }
}

const MAX_RETRIES = 3

function assertAuthenticatedApiUrl(url: string): void {
  const target = new URL(url, window.location.origin)
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) {
    throw new TypeError('Authenticated API requests must use this site’s /api/ routes')
  }
}

function waitForRetry(delay: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Request cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

// A response can arrive after a concurrent credential refresh. Do not let a
// 401 for the old credentials expire the newly restored session.
function replaceStaleCredentials(headers: Headers): boolean {
  const accessToken = getAccessToken()
  const idToken = getIdToken()
  if (!accessToken || !idToken) return false
  if (headers.get('Authorization') === `Bearer ${accessToken}` && headers.get('X-Linger-Google-ID-Token') === idToken) return false
  headers.set('Authorization', `Bearer ${accessToken}`)
  headers.set('X-Linger-Google-ID-Token', idToken)
  return true
}

export async function apiFetch<T>(url: string, init?: RequestInit, acceptedStatuses: number[] = []): Promise<{ data: T; status: number; accessToken: string | null }> {
  assertAuthenticatedApiUrl(url)
  const account = accountRequest(init)
  const headers = new Headers(account.init.headers)
  const accessToken = getAccessToken()
  const idToken = getIdToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (idToken) headers.set('X-Linger-Google-ID-Token', idToken)
  setVaultKeyHeader(headers)
  const requestInit = { ...account.init, headers, redirect: 'error' as RequestRedirect }
  let retriedCredentials = false
  for (let attempt = 0; ; attempt++) {
    account.assertCurrent()
    if (init?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const res = await fetch(url, { ...requestInit, credentials: 'include', cache: 'no-store' })
    account.assertCurrent()
    if (res.headers.get('X-Linger-Account-Changed') === '1') {
      invalidateAccount()
      // This account was replaced, so do not open the expired-session modal or
      // retain a pending save that could be retried after signing another user in.
      throw new DOMException('Account changed', 'AbortError')
    }

    if (res.ok || acceptedStatuses.includes(res.status)) {
      const data = await res.json() as T
      account.assertCurrent()
      return { data, status: res.status, accessToken: headers.get('Authorization')?.slice('Bearer '.length) ?? null }
    }
    if (res.status === 304) return { data: null as T, status: 304, accessToken: headers.get('Authorization')?.slice('Bearer '.length) ?? null }
    if (res.status === 401) {
      if (!retriedCredentials && replaceStaleCredentials(headers)) { retriedCredentials = true; continue }
      throw new TokenExpiredError()
    }
    if (res.status === 404) return { data: null as T, status: 404, accessToken: null }

    const body = await res.text()
    if (shouldRetry(res.status) && attempt < MAX_RETRIES) {
      let delay = retryDelay(attempt)
      const ra = res.headers.get('Retry-After')
      if (ra) { const s = parseFloat(ra); if (!isNaN(s)) delay = s * 1000 }
      await waitForRetry(delay * (1 + 0.2 * (Math.random() * 2 - 1)), init?.signal)
      continue
    }
    throw new DriveHttpError(res.status, body)
  }
}

async function apiFetchNoContent(url: string, init?: RequestInit): Promise<void> {
  assertAuthenticatedApiUrl(url)
  const account = accountRequest(init)
  const headers = new Headers(account.init.headers)
  const accessToken = getAccessToken()
  const idToken = getIdToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (idToken) headers.set('X-Linger-Google-ID-Token', idToken)
  setVaultKeyHeader(headers)
  const requestInit = { ...account.init, headers, redirect: 'error' as RequestRedirect }
  let retriedCredentials = false
  for (let attempt = 0; ; attempt++) {
    account.assertCurrent()
    if (init?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const res = await fetch(url, { ...requestInit, credentials: 'include', cache: 'no-store' })
    account.assertCurrent()
    if (res.headers.get('X-Linger-Account-Changed') === '1') {
      invalidateAccount()
      throw new DOMException('Account changed', 'AbortError')
    }

    if (res.ok || res.status === 204) return
    if (res.status === 401) {
      if (!retriedCredentials && replaceStaleCredentials(headers)) { retriedCredentials = true; continue }
      throw new TokenExpiredError()
    }
    if (res.status === 409) {
      const result = await res.json() as SaveConflictResponse
      throw new SaveConflictError(result.conflict ?? null)
    }

    const body = await res.text()
    if (shouldRetry(res.status) && attempt < MAX_RETRIES) {
      let delay = retryDelay(attempt)
      const ra = res.headers.get('Retry-After')
      if (ra) { const s = parseFloat(ra); if (!isNaN(s)) delay = s * 1000 }
      await waitForRetry(delay * (1 + 0.2 * (Math.random() * 2 - 1)), init?.signal)
      continue
    }
    throw new DriveHttpError(res.status, body)
  }
}

export async function listEntries(signal?: AbortSignal): Promise<DriveFileMeta[]> {
  const { data } = await apiFetch<{ files: DriveFileMeta[] }>(`${BASE}/entries`, { signal })
  return data?.files ?? []
}

export async function searchEntries(query: string, signal?: AbortSignal): Promise<DriveFileMeta[]> {
  const { data } = await apiFetch<{ files: DriveFileMeta[] }>(`${BASE}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal,
  })
  return data?.files ?? []
}

export async function getChanges(signal?: AbortSignal): Promise<ChangesResult> {
  const { data } = await apiFetch<ChangesResult>(`${BASE}/changes`, { signal })
  return { changes: data?.changes ?? [], newStartPageToken: data?.newStartPageToken ?? '' }
}

export type { DriveChange }

interface DriveReadAuthorization {
  accessToken: string | null
  verifyRefreshedToken: () => Promise<string | null>
}

export async function readDriveEntry(fileId: string, date: string, auth: DriveReadAuthorization, signal?: AbortSignal, revisionId?: string): Promise<DiaryEntry | null> {
  const account = accountRequest({ signal })
  const file = `/drive/v3/files/${encodeURIComponent(fileId)}`
  const revision = revisionId === undefined ? '' : `/revisions/${encodeURIComponent(revisionId)}`
  const url = `${GOOGLE_DRIVE}${file}${revision}?alt=media`
  // Use the bearer that passed Linger's account check for this read. A popup
  // can replace the in-memory token before the app publishes the new account.
  let token = auth.accessToken
  let retriedCredentials = false
  for (let attempt = 0; ; attempt++) {
    account.assertCurrent()
    if (!token) throw new TokenExpiredError()
    const timeout = AbortSignal.timeout(20_000)
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    account.assertCurrent()
    if (res.ok) {
      const text = await res.text()
      account.assertCurrent()
      signal?.throwIfAborted()
      return parseDriveEntry(text, date)
    }
    await res.body?.cancel()
    if (res.status === 404) return null
    if (res.status === 401) {
      const freshToken = getAccessToken()
      if (!retriedCredentials && freshToken && freshToken !== token) {
        retriedCredentials = true
        token = await auth.verifyRefreshedToken()
        continue
      }
      throw new TokenExpiredError()
    }
    if (shouldRetry(res.status) && attempt < MAX_RETRIES) {
      await waitForRetry(retryDelay(attempt), signal)
      continue
    }
    throw new DriveHttpError(res.status, 'Could not read from Google Drive')
  }
}

export async function getEntryByDate(date: string, cachedVersion?: string, fileId?: string, signal?: AbortSignal): Promise<LoadedDiaryEntry | null | 'not-modified'> {
  const account = accountRequest({ signal })
  const headers: Record<string, string> = cachedVersion ? { 'If-None-Match': cachedVersion } : {}
  const params = `?metadata=1${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ''}`
  const authorize = () => apiFetch<{ meta: DriveFileMeta }>(
    `${BASE}/entry/${encodeURIComponent(date)}${params}`,
    { headers, signal },
  )
  const { data, status, accessToken } = await authorize()
  account.assertCurrent()
  if (status === 304) return 'not-modified'
  if (status === 404 || !data) return null
  const entry = await readDriveEntry(data.meta.id, date, {
    accessToken,
    verifyRefreshedToken: async () => (await authorize()).accessToken,
  }, signal)
  return entry && { entry, meta: data.meta }
}

interface UploadResponse {
  meta?: DriveFileMeta
  uploadUrl?: string
  conflict?: DriveFileMeta | null
  canRebase?: boolean
}

function checkedUploadUrl(value: string): string {
  const url = new URL(value)
  const path = url.pathname.replace(/^\/resumable\//, '/')
  const base = '/upload/drive/v3/files'
  const validPath = path === base || (path.startsWith(`${base}/`) && /^[\w-]{1,200}$/.test(path.slice(base.length + 1)))
  if (url.origin !== GOOGLE_DRIVE || !validPath
    || !url.searchParams.get('upload_id') || url.username || url.password || url.hash) {
    throw new DriveHttpError(502, 'Invalid Google Drive upload session')
  }
  return url.href
}

export async function saveEntry(date: string, entry: DiaryEntry, optionsOrFileId: SaveEntryOptions | string = {}): Promise<DriveFileMeta> {
  const options = typeof optionsOrFileId === 'string' ? { fileId: optionsOrFileId } : optionsOrFileId
  const { signal } = options
  const account = accountRequest({ signal })
  const bytes = new TextEncoder().encode(entry.content).byteLength
  if (entry.content.length > 500_000 || bytes > 1_000_000) throw new DriveHttpError(413, 'Entry is too large')
  const operationId = crypto.randomUUID()
  const endpoint = `${BASE}/upload/${encodeURIComponent(date)}`
  function requestUpload(body: object, keepalive: boolean) {
    account.assertCurrent()
    return apiFetch<UploadResponse>(endpoint, {
      method: 'POST', signal, keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, operationId }),
    }, [409])
  }
  function prepare(fileId?: string, baseVersion?: string | null) {
    return requestUpload({ action: 'prepare', bytes, fileId, baseVersion, force: options.force }, options.keepalive ?? false)
  }

  let prepared = await prepare(options.fileId, options.baseVersion)
  for (let attempt = 0; prepared.status === 409; attempt++) {
    account.assertCurrent()
    const { conflict, canRebase } = prepared.data
    if (conflict === undefined) throw new DriveHttpError(409, 'Could not prepare Drive upload')
    const remote = conflict && await readDriveEntry(conflict.id, date, {
      accessToken: prepared.accessToken,
      verifyRefreshedToken: async () => (await apiFetch(
        `${BASE}/entry/${encodeURIComponent(date)}?metadata=1&fileId=${encodeURIComponent(conflict.id)}`, { signal },
      )).accessToken,
    }, signal)
    account.assertCurrent()
    if (remote && conflict && canRebase) {
      // Covers a lost save acknowledgement and a metadata-only version bump.
      if (remote.content === entry.content) return conflict
      if (attempt === 0 && options.baseContent != null && remote.content === options.baseContent) {
        prepared = await prepare(conflict.id, conflict.version)
        continue
      }
    }
    throw new SaveConflictError(remote && conflict ? { entry: remote, meta: conflict } : null)
  }
  account.assertCurrent()
  if (prepared.data?.meta) return prepared.data.meta
  if (!prepared.data?.uploadUrl) throw new DriveHttpError(502, 'Missing Google Drive upload session')
  const url = checkedUploadUrl(prepared.data.uploadUrl)
  let uploadError: unknown
  try {
    const upload = await fetch(url, {
      method: 'PUT', body: entry.content,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      keepalive: Boolean(options.keepalive && bytes <= KEEPALIVE_MAX_BYTES),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    })
    await upload.body?.cancel()
    if (!upload.ok) uploadError = new DriveHttpError(upload.status, 'Could not upload to Google Drive')
  } catch (error) {
    uploadError = error
  }
  // Even a lost HTTP response can mean Drive accepted the upload.
  account.assertCurrent()
  signal?.throwIfAborted()
  try {
    const { data } = await requestUpload({ action: 'complete' }, true)
    if (data?.meta) return data.meta
  } catch (error) {
    if (error instanceof TokenExpiredError || signal?.aborted) throw error
    throw uploadError ?? error
  }
  throw uploadError ?? new DriveHttpError(409, 'Could not confirm Google Drive upload')
}

export async function deleteEntry(date: string, signal?: AbortSignal, target?: { fileId: string; baseVersion: string }): Promise<void> {
  await apiFetchNoContent(`${BASE}/entry/${encodeURIComponent(date)}`, {
    method: 'DELETE', signal,
    headers: target ? { 'X-Linger-File-Id': target.fileId, 'If-Match': target.baseVersion } : undefined,
  })
}

export interface MigrateExtensionsResult {
  migrated: number
  // True when the server kicked off a chunked S3 re-mirror of the migrated dates
  // (their prior mirror, if any, is now stamped with a stale pre-rename Drive
  // version) — the caller should start backfill-progress polling so it runs to
  // completion instead of stopping after the first chunk.
  s3Resyncing: boolean
}

export async function migrateExtensions(): Promise<MigrateExtensionsResult> {
  const { data } = await apiFetch<{ migrated: number; s3Resyncing?: boolean }>(`${BASE}/migrate`, { method: 'POST' })
  return { migrated: data?.migrated ?? 0, s3Resyncing: data?.s3Resyncing ?? false }
}
