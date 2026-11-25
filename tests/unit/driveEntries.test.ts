import { expect, test, vi } from 'vitest'
import type { DriveFileMeta } from '../../src/types'
import {
  TokenExpiredError,
  DriveHttpError,
  SaveConflictError,
  listEntries,
  searchEntries,
  getEntryByDate,
  saveEntry,
  deleteEntry,
  getChanges,
} from '../../src/api/driveEntries'
import { FetchMock, jsonResponse, textResponse } from '../helpers/mockFetch'
import { clearOAuthCredentials, setOAuthCredentials } from '../../src/lib/oauthCredentials'

const fetchMock = new FetchMock()
const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test'
const prepared = () => jsonResponse({ uploadUrl })

test.beforeEach(() => fetchMock.reset())
test.afterEach(() => { fetchMock.restore(); vi.unstubAllGlobals(); clearOAuthCredentials() })

test.describe('driveEntries proxy API', () => {
  test.each(['read', 'delete'])('retries a stale 401 after credentials are refreshed (%s)', async operation => {
    const credentials = (token: string) => ({ accessToken: token, idToken: `${token}-id`, expiresAt: Date.now() + 120_000 })
    setOAuthCredentials(credentials('old'))
    let finish!: (response: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(operation === 'read' ? jsonResponse({ files: [] }) : new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)

    const pending = operation === 'read' ? listEntries() : deleteEntry('2026-05-01')
    setOAuthCredentials(credentials('new'))
    finish(new Response(null, { status: 401 }))
    await pending

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer new')
  })

  test('listEntries calls /api/drive/entries with credentials', async () => {
    const files: DriveFileMeta[] = [
      { id: 'entry-1', name: 'diary-2026-04-29.json', version: '11' },
    ]
    fetchMock.mock(jsonResponse({ files }))

    const result = await listEntries()

    expect(result).toEqual(files)
    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/api/drive/entries')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    expect(fetchMock.calls[0].init?.cache).toBe('no-store')
  })

  test('listEntries returns empty array when files missing', async () => {
    fetchMock.mock(jsonResponse({}))

    const result = await listEntries()

    expect(result).toEqual([])
  })

  test('searchEntries sends the query in the request body, not the URL', async () => {
    const files: DriveFileMeta[] = [{ id: 'e-1', name: 'diary-2026-05-01.json', version: '1' }]
    fetchMock.mock(jsonResponse({ files }))

    const result = await searchEntries('hello world')

    expect(result).toEqual(files)
    expect(fetchMock.calls[0].url).toBe('/api/drive/search')
    expect(fetchMock.calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.calls[0].init?.body))).toEqual({ query: 'hello world' })
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })

  test('loads metadata from Linger and downloads only with a Google access token', async () => {
    const entry = { date: '2026-04-29', content: 'today' }
    const meta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '3' }
    fetchMock.mock(jsonResponse({ meta }), textResponse('today', 200))

    expect(await getEntryByDate('2026-04-29')).toEqual({ entry, meta })
    expect(fetchMock.calls[0].url).toBe('/api/drive/entry/2026-04-29?metadata=1')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    expect(fetchMock.calls[1].url).toBe('https://www.googleapis.com/drive/v3/files/entry-1?alt=media')
    expect(fetchMock.calls[1].init).toMatchObject({
      credentials: 'omit', headers: { Authorization: 'Bearer test-access-token' }, redirect: 'error',
    })
  })

  test('uses the token verified by the metadata request during a concurrent credential swap', async () => {
    const credentials = (token: string) => ({ accessToken: token, idToken: `${token}-id`, expiresAt: Date.now() + 120_000 })
    setOAuthCredentials(credentials('verified'))
    const fetch = vi.fn()
      .mockImplementationOnce(async () => {
        setOAuthCredentials(credentials('different'))
        return jsonResponse({ meta: { id: 'entry-1' } })
      })
      .mockResolvedValueOnce(textResponse('today', 200))
    vi.stubGlobal('fetch', fetch)

    await getEntryByDate('2026-04-29')

    expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer verified')
  })

  test('verifies a refreshed credential with Linger before retrying a Drive 401', async () => {
    const credentials = (token: string) => ({ accessToken: token, idToken: `${token}-id`, expiresAt: Date.now() + 120_000 })
    setOAuthCredentials(credentials('old'))
    const metadata = { meta: { id: 'entry-1' } }
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockImplementationOnce(async () => {
        setOAuthCredentials(credentials('new'))
        return textResponse('', 401)
      })
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(textResponse('today', 200))
    vi.stubGlobal('fetch', fetch)

    await expect(getEntryByDate('2026-04-29')).resolves.toMatchObject({ entry: { content: 'today' } })
    expect(fetch.mock.calls[2][0]).toBe('/api/drive/entry/2026-04-29?metadata=1')
    expect(new Headers(fetch.mock.calls[3][1].headers).get('Authorization')).toBe('Bearer new')
  })

  test('getEntryByDate returns null on 404', async () => {
    fetchMock.mock(jsonResponse(null, 404))

    expect(await getEntryByDate('2026-04-29')).toBeNull()
  })

  test('conditional metadata read does not download the body on a cache hit', async () => {
    fetchMock.mock(textResponse('', 304))

    expect(await getEntryByDate('2026-04-29', '3', 'entry-1')).toBe('not-modified')
    expect(fetchMock.calls).toHaveLength(1)
    expect(new Headers(fetchMock.calls[0].init?.headers).get('If-None-Match')).toBe('3')
  })

  test('downloads content in parallel with metadata verification when fileId is known and uncached', async () => {
    setOAuthCredentials({ accessToken: 'test-access-token', idToken: 'test-id', expiresAt: Date.now() + 120_000 })
    const meta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '3' }
    let resolveAuth!: (res: unknown) => void
    let resolveContent!: (res: unknown) => void
    const fetch = vi.fn((url: string) => {
      if (url.startsWith('/api/drive/entry/')) return new Promise(r => { resolveAuth = r })
      return new Promise(r => { resolveContent = r })
    })
    vi.stubGlobal('fetch', fetch)

    const pending = getEntryByDate('2026-04-29', undefined, 'entry-1')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('/api/drive/entry/2026-04-29?metadata=1&fileId=entry-1')
    expect(fetch.mock.calls[1][0]).toBe('https://www.googleapis.com/drive/v3/files/entry-1?alt=media')

    resolveAuth(jsonResponse({ meta }))
    resolveContent(textResponse('parallel body', 200))
    await expect(pending).resolves.toEqual({ entry: { date: '2026-04-29', content: 'parallel body' }, meta })
  })

  test('discards parallel content download when metadata verification returns 404', async () => {
    setOAuthCredentials({ accessToken: 'test-access-token', idToken: 'test-id', expiresAt: Date.now() + 120_000 })
    let contentSignal: AbortSignal | undefined
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/drive/entry/')) return Promise.resolve(jsonResponse(null, 404))
      contentSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetch)

    await expect(getEntryByDate('2026-04-29', undefined, 'entry-1')).resolves.toBeNull()
    expect(contentSignal?.aborted).toBe(true)
  })

  test('sends only the diary text to Drive, then confirms with metadata', async () => {
    const meta: DriveFileMeta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '1' }
    fetchMock.mock(prepared(), textResponse('', 200), jsonResponse({ meta }))

    const entry = { date: '2026-04-29', content: '日記' }
    expect(await saveEntry(entry.date, entry, { fileId: 'entry-1', baseVersion: '1', baseContent: 'private base' })).toEqual(meta)

    const [prepare, upload, complete] = fetchMock.calls
    expect(prepare.url).toBe('/api/drive/upload/2026-04-29')
    expect(complete.url).toBe(prepare.url)
    const prepareBody = JSON.parse(String(prepare.init?.body))
    expect(prepareBody).toEqual({ action: 'prepare', bytes: 6, fileId: 'entry-1', baseVersion: '1', operationId: expect.any(String) })
    expect(upload).toMatchObject({ url: uploadUrl, init: { method: 'PUT', credentials: 'omit', body: '日記' } })
    expect(new Headers(upload.init?.headers).has('Authorization')).toBe(false)
    expect(JSON.parse(String(complete.init?.body))).toEqual({ action: 'complete', operationId: prepareBody.operationId })
  })

  test('rejects an upload session on an unexpected origin before sending text', async () => {
    fetchMock.mock(jsonResponse({ uploadUrl: 'https://example.com/upload/drive/v3/files?upload_id=invalid' }))
    await expect(saveEntry('2026-04-29', { date: '2026-04-29', content: 'secret' })).rejects.toMatchObject({ status: 502 })
    expect(fetchMock.calls).toHaveLength(1)
  })

  test('checks for a successful Drive commit when the upload response was lost', async () => {
    const meta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '2' }
    setOAuthCredentials({ accessToken: 'test-token', idToken: 'test-id', expiresAt: Date.now() + 60_000 })
    const fetch = vi.fn()
      .mockResolvedValueOnce(prepared())
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(jsonResponse({ meta }))
    vi.stubGlobal('fetch', fetch)

    await expect(saveEntry('2026-04-29', { date: '2026-04-29', content: 'saved' })).resolves.toEqual(meta)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('allows upload keepalive for small bodies only', async () => {
    const meta: DriveFileMeta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '2' }
    fetchMock.mock(prepared(), textResponse('', 200), jsonResponse({ meta }), prepared(), textResponse('', 200), jsonResponse({ meta }))

    await saveEntry('2026-04-29', { date: '2026-04-29', content: 'short note' }, { keepalive: true })
    await saveEntry('2026-04-29', { date: '2026-04-29', content: 'x'.repeat(65_000) }, { keepalive: true })
    expect(fetchMock.calls[1].init?.keepalive).toBe(true)
    expect(fetchMock.calls[4].init?.keepalive).toBe(false)
  })

  test('downloads conflicting text directly and keeps it out of Linger requests', async () => {
    const conflict = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '3' }
    fetchMock.mock(jsonResponse({ conflict, canRebase: true }, 409), textResponse('remote', 200))

    const entry = { date: '2026-04-29', content: 'updated' }
    await expect(saveEntry(entry.date, entry, { fileId: conflict.id, baseVersion: '2', baseContent: 'local base' }))
      .rejects.toMatchObject({ remote: { entry: { date: entry.date, content: 'remote' }, meta: conflict } })

    expect(fetchMock.calls[0].init?.body).not.toContain('local base')
    expect(fetchMock.calls[1].url).toBe('https://www.googleapis.com/drive/v3/files/entry-1?alt=media')
  })

  test('rechecks the version with Linger when the remote text still matches the base', async () => {
    const meta = { id: 'entry-1', name: 'diary-2026-04-29.txt', version: '3' }
    fetchMock.mock(jsonResponse({ conflict: meta, canRebase: true }, 409), textResponse('base', 200),
      prepared(), textResponse('', 200), jsonResponse({ meta: { ...meta, version: '4' } }))

    await expect(saveEntry('2026-04-29', { date: '2026-04-29', content: 'edit' }, {
      fileId: meta.id, baseVersion: '2', baseContent: 'base',
    })).resolves.toMatchObject({ version: '4' })
    expect(JSON.parse(String(fetchMock.calls[2].init?.body))).toMatchObject({ fileId: meta.id, baseVersion: '3' })
  })

  test('saveEntry maps deleted-entry conflicts to SaveConflictError with null remote', async () => {
    fetchMock.mock(jsonResponse({ conflict: null }, 409))
    const entry = { date: '2026-04-29', content: 'updated' }

    const err = await saveEntry(entry.date, entry, { fileId: 'entry-1', baseVersion: '2' }).catch(e => e)
    expect(err).toBeInstanceOf(SaveConflictError)
    expect((err as SaveConflictError).remote).toBeNull()
  })

  test('getChanges calls /api/drive/changes and returns changes + token', async () => {
    const changes = [
      { fileId: 'file-1', removed: false, file: { id: 'file-1', name: 'diary-2026-05-01.md', version: '2' } },
      { fileId: 'file-2', removed: true },
    ]
    fetchMock.mock(jsonResponse({ changes, newStartPageToken: 'tok-next' }))

    const result = await getChanges()

    expect(result).toEqual({ changes, newStartPageToken: 'tok-next' })
    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/api/drive/changes')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })

  test('getChanges defaults to empty changes when fields are missing', async () => {
    fetchMock.mock(jsonResponse({}))

    const result = await getChanges()

    expect(result).toEqual({ changes: [], newStartPageToken: '' })
  })

  test('getChanges throws TokenExpiredError on 401', async () => {
    fetchMock.mock(textResponse('expired', 401))

    await expect(getChanges()).rejects.toBeInstanceOf(TokenExpiredError)
  })

  test('deleteEntry sends DELETE to /api/drive/entry/:date', async () => {
    fetchMock.mock(textResponse('', 204))

    await expect(deleteEntry('2026-04-29', undefined, { fileId: 'original-file', baseVersion: '7' })).resolves.toBeUndefined()

    expect(fetchMock.calls[0].url).toBe('/api/drive/entry/2026-04-29')
    expect(fetchMock.calls[0].init?.method).toBe('DELETE')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    const headers = new Headers(fetchMock.calls[0].init?.headers)
    expect(headers.get('X-Linger-File-Id')).toBe('original-file')
    expect(headers.get('If-Match')).toBe('7')
  })

  test('deleteEntry reports a version conflict without retrying the deletion', async () => {
    const remote = { entry: { date: '2026-04-29', content: 'updated' }, meta: { id: 'new-file', version: '8' } }
    fetchMock.mock(jsonResponse({ conflict: remote }, 409))
    const error = await deleteEntry('2026-04-29', undefined, { fileId: 'old-file', baseVersion: '7' }).catch(e => e)
    expect(error).toBeInstanceOf(SaveConflictError)
    expect(error.remote).toEqual(remote)
    expect(fetchMock.calls).toHaveLength(1)
  })

  test('throws TokenExpiredError on 401', async () => {
    fetchMock.mock(textResponse('expired', 401))

    await expect(listEntries()).rejects.toBeInstanceOf(TokenExpiredError)
  })

  test('throws DriveHttpError on non-retryable error', async () => {
    fetchMock.mock(textResponse('forbidden', 403))

    const err = await listEntries().catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(403)
  })
})

test.describe('retry behaviour', () => {
  test('503 retries and succeeds on second attempt', async () => {
    fetchMock.mock(
      textResponse('unavailable', 503, { 'Retry-After': '0.01' }),
      jsonResponse({ files: [] }),
    )

    await expect(listEntries()).resolves.toEqual([])
    expect(fetchMock.calls).toHaveLength(2)
  })

  test('429 with Retry-After: 0.1 retries using the header value', async () => {
    fetchMock.mock(
      textResponse('rate limited', 429, { 'Retry-After': '0.1' }),
      jsonResponse({ files: [] }),
    )

    await expect(listEntries()).resolves.toEqual([])
    expect(fetchMock.calls).toHaveLength(2)
  })

  test('401 throws TokenExpiredError immediately without retry', async () => {
    fetchMock.mock(textResponse('expired', 401))

    await expect(listEntries()).rejects.toBeInstanceOf(TokenExpiredError)
    expect(fetchMock.calls).toHaveLength(1)
  })

  test('500 repeated 4 times throws DriveHttpError after exhausting retries', async () => {
    const r500 = () => textResponse('server error', 500, { 'Retry-After': '0.01' })
    fetchMock.mock(r500(), r500(), r500(), r500())

    const err = await listEntries().catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(500)
    expect(fetchMock.calls).toHaveLength(4)
  })
})
