import type { ChangesResult, DiaryEntry, DriveChange, DriveFileMeta, LoadedDiaryEntry } from '../types'
import { accountRequest, invalidateAccount } from '../lib/accountSession'

const BASE = '/api/drive'

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
}

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

export async function apiFetch<T>(url: string, init?: RequestInit, acceptedStatuses: number[] = []): Promise<{ data: T; status: number }> {
  const account = accountRequest(init)
  for (let attempt = 0; ; attempt++) {
    account.assertCurrent()
    if (init?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const res = await fetch(url, { ...account.init, credentials: 'include', cache: 'no-store' })
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
      return { data, status: res.status }
    }
    if (res.status === 304) return { data: null as T, status: 304 }
    if (res.status === 401) throw new TokenExpiredError()
    if (res.status === 404) return { data: null as T, status: 404 }

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
  const account = accountRequest(init)
  for (let attempt = 0; ; attempt++) {
    account.assertCurrent()
    if (init?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const res = await fetch(url, { ...account.init, credentials: 'include', cache: 'no-store' })
    account.assertCurrent()
    if (res.headers.get('X-Linger-Account-Changed') === '1') {
      invalidateAccount()
      throw new DOMException('Account changed', 'AbortError')
    }

    if (res.ok || res.status === 204) return
    if (res.status === 401) throw new TokenExpiredError()
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
  const { data } = await apiFetch<{ files: DriveFileMeta[] }>(`${BASE}/search?q=${encodeURIComponent(query)}`, { signal })
  return data?.files ?? []
}

export async function getChanges(signal?: AbortSignal): Promise<ChangesResult> {
  const { data } = await apiFetch<ChangesResult>(`${BASE}/changes`, { signal })
  return { changes: data?.changes ?? [], newStartPageToken: data?.newStartPageToken ?? '' }
}

export type { DriveChange }

export async function getEntryByDate(date: string, cachedVersion?: string, fileId?: string, signal?: AbortSignal): Promise<LoadedDiaryEntry | null | 'not-modified'> {
  const headers: Record<string, string> = cachedVersion ? { 'If-None-Match': cachedVersion } : {}
  const params = fileId ? `?fileId=${encodeURIComponent(fileId)}` : ''
  const { data, status } = await apiFetch<{ entry: DiaryEntry; meta: DriveFileMeta }>(
    `${BASE}/entry/${encodeURIComponent(date)}${params}`,
    { headers, signal },
  )
  if (status === 304) return 'not-modified'
  if (status === 404 || !data) return null
  return { entry: data.entry, meta: data.meta }
}

export async function saveEntry(date: string, entry: DiaryEntry, optionsOrFileId: SaveEntryOptions | string = {}): Promise<DriveFileMeta> {
  const options = typeof optionsOrFileId === 'string' ? { fileId: optionsOrFileId } : optionsOrFileId
  const { data, status } = await apiFetch<DriveFileMeta | SaveConflictResponse>(`${BASE}/entry/${encodeURIComponent(date)}`, {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: entry.content,
      fileId: options.fileId,
      baseVersion: options.baseVersion,
      baseContent: options.baseContent,
      force: options.force,
    }),
  }, [409])
  if (status === 409) throw new SaveConflictError((data as SaveConflictResponse).conflict ?? null)
  return data as DriveFileMeta
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
