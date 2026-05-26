import { expect, test } from '@playwright/test'
import type { DiaryEntry } from '../src/types'
import { listRevisions, getRevisionContent } from '../src/api/driveRevisions'
import { TokenExpiredError, DriveHttpError } from '../src/api/driveEntries'

type FetchCall = { url: string; init?: RequestInit }
type MockResponse = {
  status: number
  ok: boolean
  headers: Headers
  json: () => Promise<unknown>
  text: () => Promise<string>
}

const originalFetch = globalThis.fetch
let calls: FetchCall[]
let responses: MockResponse[]

function jsonResponse(body: unknown, status = 200): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function mockFetch(...nextResponses: MockResponse[]): void {
  responses = [...nextResponses]
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    if (!response) throw new Error(`Unexpected fetch: ${String(input)}`)
    return response as Response
  }) as typeof fetch
}

test.beforeEach(() => {
  calls = []
  responses = []
})

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test.describe('listRevisions', () => {
  test('returns revisions in the order the API provides', async () => {
    // The Worker pre-sorts revisions newest-first; frontend passes through unchanged.
    mockFetch(jsonResponse([
      { id: 'rev-3', modifiedTime: '2026-05-03T14:00:00Z' },
      { id: 'rev-2', modifiedTime: '2026-05-02T12:00:00Z' },
      { id: 'rev-1', modifiedTime: '2026-05-01T10:00:00Z' },
    ]))

    const revisions = await listRevisions('file-1')

    expect(revisions).toHaveLength(3)
    expect(revisions[0].id).toBe('rev-3')
    expect(revisions[1].id).toBe('rev-2')
    expect(revisions[2].id).toBe('rev-1')
  })

  test('calls /api/drive/revisions/:fileId with credentials', async () => {
    mockFetch(jsonResponse([]))

    await listRevisions('file-abc')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/revisions/file-abc')
    expect(calls[0].init?.credentials).toBe('include')
  })

  test('returns empty array when response is empty', async () => {
    mockFetch(jsonResponse([]))

    const revisions = await listRevisions('file-1')

    expect(revisions).toEqual([])
  })

  test('throws TokenExpiredError on 401', async () => {
    mockFetch(jsonResponse({ error: 'Unauthorized' }, 401))

    await expect(listRevisions('file-1')).rejects.toThrow(TokenExpiredError)
  })

  test('throws DriveHttpError on 403', async () => {
    mockFetch(jsonResponse({ error: 'Forbidden' }, 403))

    const err = await listRevisions('file-1').catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(403)
  })
})

test.describe('getRevisionContent', () => {
  test('fetches revision content from /api/drive/revisions/:fileId/:revisionId', async () => {
    const entry: DiaryEntry = { date: '2026-05-01', content: 'old text' }
    mockFetch(jsonResponse(entry))

    const result = await getRevisionContent('file-1', 'rev-2')

    expect(result.content).toBe('old text')
    expect(result.date).toBe('2026-05-01')
  })

  test('calls the correct URL with credentials', async () => {
    mockFetch(jsonResponse({ date: '2026-05-01', content: '' }))

    await getRevisionContent('file-abc', 'rev-xyz')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/drive/revisions/file-abc/rev-xyz')
    expect(calls[0].init?.credentials).toBe('include')
  })

  test('throws TokenExpiredError on 401', async () => {
    mockFetch(jsonResponse({ error: 'Unauthorized' }, 401))

    await expect(getRevisionContent('file-1', 'rev-1')).rejects.toThrow(TokenExpiredError)
  })

  test('throws DriveHttpError on 404', async () => {
    mockFetch(jsonResponse({ error: 'Not Found' }, 404))

    const err = await getRevisionContent('file-1', 'bad-rev').catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(404)
  })
})
