import { expect, test } from '@playwright/test'
import type { DriveFileMeta } from '../src/types'
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
} from '../src/api/driveEntries'
import { FetchMock, jsonResponse, textResponse } from './helpers/mockFetch'

const fetchMock = new FetchMock()

test.beforeEach(() => fetchMock.reset())
test.afterEach(() => fetchMock.restore())

test.describe('driveEntries proxy API', () => {
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

  test('searchEntries calls /api/drive/search with encoded query', async () => {
    const files: DriveFileMeta[] = [{ id: 'e-1', name: 'diary-2026-05-01.json', version: '1' }]
    fetchMock.mock(jsonResponse({ files }))

    const result = await searchEntries('hello world')

    expect(result).toEqual(files)
    expect(fetchMock.calls[0].url).toContain('/api/drive/search?q=')
    expect(decodeURIComponent(fetchMock.calls[0].url)).toContain('hello world')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })

  test('getEntryByDate returns entry and meta on success', async () => {
    const entry = { date: '2026-04-29', content: 'today', updated_at: '2026-04-29T00:00:00.000Z' }
    const meta = { id: 'entry-1', name: 'diary-2026-04-29.json', version: '3' }
    fetchMock.mock(jsonResponse({ entry, meta }))

    const result = await getEntryByDate('2026-04-29')

    expect(result).toEqual({ entry, meta })
    expect(fetchMock.calls[0].url).toBe('/api/drive/entry/2026-04-29')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })

  test('getEntryByDate returns null on 404', async () => {
    fetchMock.mock(jsonResponse(null, 404))

    const result = await getEntryByDate('2026-04-29')

    expect(result).toBeNull()
  })

  test('saveEntry posts JSON to /api/drive/entry/:date', async () => {
    const meta: DriveFileMeta = { id: 'entry-1', name: 'diary-2026-04-29.json', version: '1' }
    fetchMock.mock(jsonResponse(meta))

    const entry = { date: '2026-04-29', content: 'saved text', updated_at: '2026-04-29T00:00:00.000Z' }
    const result = await saveEntry('2026-04-29', entry)

    expect(result).toEqual(meta)
    expect(fetchMock.calls[0].url).toBe('/api/drive/entry/2026-04-29')
    expect(fetchMock.calls[0].init?.method).toBe('POST')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    const body = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(body.content).toBe('saved text')
    expect(body.fileId).toBeUndefined()
  })

  test('saveEntry includes fileId when provided', async () => {
    const meta: DriveFileMeta = { id: 'entry-1', name: 'diary-2026-04-29.json', version: '2' }
    fetchMock.mock(jsonResponse(meta))

    const entry = { date: '2026-04-29', content: 'updated', updated_at: '2026-04-29T00:00:00.000Z' }
    await saveEntry('2026-04-29', entry, 'entry-1')

    const body = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(body.fileId).toBe('entry-1')
  })

  test('saveEntry sends conflict metadata and throws on 409 conflict', async () => {
    const conflict = {
      entry: { date: '2026-04-29', content: 'remote', updated_at: '2026-04-29T00:00:00.000Z' },
      meta: { id: 'entry-1', name: 'diary-2026-04-29.json', version: '3' },
    }
    fetchMock.mock(jsonResponse({ conflict }, 409))

    const entry = { date: '2026-04-29', content: 'updated', updated_at: '2026-04-29T00:00:00.000Z' }
    const err = await saveEntry('2026-04-29', entry, {
      fileId: 'entry-1',
      baseVersion: '2',
      baseContent: 'local base',
    }).catch(e => e)

    expect(err).toBeInstanceOf(SaveConflictError)
    expect((err as SaveConflictError).remote).toEqual(conflict)
    const body = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(body).toMatchObject({
      fileId: 'entry-1',
      baseVersion: '2',
      baseContent: 'local base',
    })
  })

  test('saveEntry maps deleted-entry conflicts to SaveConflictError with null remote', async () => {
    fetchMock.mock(jsonResponse({ conflict: null }, 409))

    const entry = { date: '2026-04-29', content: 'updated', updated_at: '2026-04-29T00:00:00.000Z' }
    const err = await saveEntry('2026-04-29', entry, {
      fileId: 'entry-1',
      baseVersion: '2',
      baseContent: 'local base',
    }).catch(e => e)

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

    await expect(deleteEntry('2026-04-29')).resolves.toBeUndefined()

    expect(fetchMock.calls[0].url).toBe('/api/drive/entry/2026-04-29')
    expect(fetchMock.calls[0].init?.method).toBe('DELETE')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
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
