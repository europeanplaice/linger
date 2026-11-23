import { expect, test } from 'vitest'
import { listRevisions, getRevisionContent } from '../../src/api/driveRevisions'
import { TokenExpiredError, DriveHttpError } from '../../src/api/driveEntries'
import { FetchMock, jsonResponse, textResponse } from '../helpers/mockFetch'

const fetchMock = new FetchMock()

test.beforeEach(() => fetchMock.reset())
test.afterEach(() => fetchMock.restore())

test.describe('listRevisions', () => {
  test('returns revisions in the order the API provides', async () => {
    // The Worker pre-sorts revisions newest-first; frontend passes through unchanged.
    fetchMock.mock(jsonResponse([
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
    fetchMock.mock(jsonResponse([]))

    await listRevisions('file-abc')

    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe('/api/drive/revisions/file-abc')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
  })

  test('returns empty array when response is empty', async () => {
    fetchMock.mock(jsonResponse([]))

    const revisions = await listRevisions('file-1')

    expect(revisions).toEqual([])
  })

  test('throws TokenExpiredError on 401', async () => {
    fetchMock.mock(jsonResponse({ error: 'Unauthorized' }, 401))

    await expect(listRevisions('file-1')).rejects.toThrow(TokenExpiredError)
  })

  test('throws DriveHttpError on 403', async () => {
    fetchMock.mock(jsonResponse({ error: 'Forbidden' }, 403))

    const err = await listRevisions('file-1').catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(403)
  })
})

test.describe('getRevisionContent', () => {
  test('downloads a legacy revision directly and parses its date', async () => {
    fetchMock.mock(jsonResponse({ ok: true }), textResponse('---\ndate: 2026-05-01\n---\nold text', 200))

    const result = await getRevisionContent('file-1', 'rev-2')

    expect(result.content).toBe('old text')
    expect(result.date).toBe('2026-05-01')
  })

  test('calls the correct URL with credentials', async () => {
    fetchMock.mock(jsonResponse({ ok: true }), textResponse('', 200))

    await getRevisionContent('file-abc', 'rev-xyz')

    expect(fetchMock.calls[0].url).toBe('/api/drive/revisions/file-abc/rev-xyz?metadata=1')
    expect(fetchMock.calls[0].init?.credentials).toBe('include')
    expect(fetchMock.calls[1].url).toBe('https://www.googleapis.com/drive/v3/files/file-abc/revisions/rev-xyz?alt=media')
    expect(fetchMock.calls[1].init?.credentials).toBe('omit')
  })

  test('throws TokenExpiredError on 401', async () => {
    fetchMock.mock(jsonResponse({ error: 'Unauthorized' }, 401))

    await expect(getRevisionContent('file-1', 'rev-1')).rejects.toThrow(TokenExpiredError)
  })

  test('throws DriveHttpError on 404', async () => {
    fetchMock.mock(jsonResponse({ error: 'Not Found' }, 404))

    const err = await getRevisionContent('file-1', 'bad-rev').catch(e => e)
    expect(err).toBeInstanceOf(DriveHttpError)
    expect((err as DriveHttpError).status).toBe(404)
  })
})
