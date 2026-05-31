import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  ensureFolder, getEntryContent, saveEntry, deleteEntry,
  listRevisions, getRevisionContent, getDiaryFileMeta, DriveError, DriveConflictError,
  listEntries, getStartPageToken, getChanges, migrateMdToTxt,
} from '../../functions/_shared/drive'

function mockFetch(response: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

function driveJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function driveMarkdownResponse(entry: { date: string; content: string }, status = 200): Response {
  const body = `---\ndate: ${entry.date}\n---\n\n${entry.content}`
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DriveError', () => {
  it('captures status and message', () => {
    const e = new DriveError(404, 'Not found')
    expect(e.status).toBe(404)
    expect(e.message).toBe('Not found')
    expect(e.name).toBe('DriveError')
  })
})

describe('ensureFolder', () => {
  it('returns cached folder_id from session', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'cached' }
    const env = { SESSIONS: { put: vi.fn() } }
    const result = await ensureFolder('token', 'sid', session, env as any)
    expect(result).toBe('cached')
  })

  it('finds existing folder on Drive', async () => {
    mockFetch(driveJsonResponse({ files: [{ id: 'existing-folder' }] }))
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any)

    expect(result).toBe('existing-folder')
    expect(session.folder_id).toBe('existing-folder')
    expect(put).toHaveBeenCalledOnce()
  })

  it('creates folder when none exists on Drive', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [] }))
      .mockResolvedValueOnce(driveJsonResponse({ id: 'new-folder' })))
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any)
    expect(result).toBe('new-folder')
  })
})

describe('getEntryContent', () => {
  it('fetches entry content from Drive', async () => {
    const entry = { date: '2026-05-01', content: 'hello' }
    mockFetch(driveMarkdownResponse(entry))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result).toEqual(entry)
    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    expect(fetchCall[1].headers['Accept-Encoding']).toBe('gzip')
    expect(fetchCall[1].headers['User-Agent']).toContain('(gzip)')
  })

  it('parses a bare body (no frontmatter) using the filename date', async () => {
    mockFetch(new Response('just the body\nwith lines', { status: 200, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } }))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result).toEqual({ date: '2026-05-01', content: 'just the body\nwith lines' })
  })

  it('strips legacy frontmatter and prefers the filename date', async () => {
    mockFetch(driveMarkdownResponse({ date: '2026-01-01', content: 'legacy body' }))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result).toEqual({ date: '2026-05-01', content: 'legacy body' })
  })

  it('retries on 429 then succeeds', async () => {
    const entry = { date: '2026-05-01', content: 'hello' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
      .mockResolvedValueOnce(driveMarkdownResponse(entry)))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result.content).toBe('hello')
  })

  it('retries on 500 then succeeds', async () => {
    const entry = { date: '2026-05-01', content: 'ok', updated_at: '' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(driveMarkdownResponse(entry)))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result.content).toBe('ok')
  })

  it('throws DriveError after exhausting all retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 503 })),
    ))

    await expect(getEntryContent('token', 'file-123', '2026-05-01')).rejects.toThrow(DriveError)
  })

  it('throws DriveError immediately on 404 (no retry)', async () => {
    mockFetch(new Response('Not Found', { status: 404 }))

    await expect(getEntryContent('token', 'file-123', '2026-05-01')).rejects.toThrow(DriveError)
  })

  it('respects Retry-After header', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // neutralise jitter: factor = 1.0
    try {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
      const entry = { date: '2026-05-01', content: 'ok', updated_at: '' }
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response('Rate Limited', { status: 429, headers: { 'Retry-After': '1' } }))
        .mockResolvedValueOnce(driveMarkdownResponse(entry)))

      const promise = getEntryContent('token', 'file-123', '2026-05-01')
      await vi.runAllTimersAsync()
      await promise

      const delayArg = setTimeoutSpy.mock.calls[0][1] as number
      expect(delayArg).toBe(1000)
    } finally {
      vi.mocked(Math.random).mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('getDiaryFileMeta', () => {
  it('returns metadata for a markdown diary file in the cached diary folder', async () => {
    const meta = {
      id: 'file-1',
      name: 'diary-2026-05-01.md',
      mimeType: 'text/plain',
      parents: ['folder-1'],
      trashed: false,
      version: '2',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'folder-1' }

    const result = await getDiaryFileMeta('token', 'sid', session, { SESSIONS: { put: vi.fn() } } as any, 'file-1', '2026-05-01')

    expect(result).toEqual(meta)
  })

  it('rejects files outside the diary folder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse({
      id: 'file-1',
      name: 'diary-2026-05-01.md',
      mimeType: 'text/plain',
      parents: ['other-folder'],
      trashed: false,
    })))
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, { SESSIONS: { put: vi.fn() } } as any, 'file-1', '2026-05-01'))
      .rejects.toMatchObject({ status: 404, message: 'not_found' })
  })

  it('accepts a .txt diary file', async () => {
    const meta = {
      id: 'file-1',
      name: 'diary-2026-05-01.txt',
      mimeType: 'text/plain',
      parents: ['folder-1'],
      trashed: false,
      version: '2',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'folder-1' }

    const result = await getDiaryFileMeta('token', 'sid', session, { SESSIONS: { put: vi.fn() } } as any, 'file-1', '2026-05-01')

    expect(result).toEqual(meta)
  })

  it('rejects diary files for a different date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse({
      id: 'file-1',
      name: 'diary-2026-05-02.md',
      mimeType: 'text/plain',
      parents: ['folder-1'],
      trashed: false,
    })))
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, { SESSIONS: { put: vi.fn() } } as any, 'file-1', '2026-05-01'))
      .rejects.toMatchObject({ status: 404, message: 'not_found' })
  })

  it('rejects trashed diary files', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse({
      id: 'file-1',
      name: 'diary-2026-05-01.md',
      mimeType: 'text/plain',
      parents: ['folder-1'],
      trashed: true,
    })))
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, { SESSIONS: { put: vi.fn() } } as any, 'file-1', '2026-05-01'))
      .rejects.toMatchObject({ status: 404, message: 'not_found' })
  })
})

describe('DriveConflictError', () => {
  it('has the correct name and message', () => {
    const e = new DriveConflictError()
    expect(e.name).toBe('DriveConflictError')
    expect(e.message).toBe('Version conflict')
    expect(e).toBeInstanceOf(Error)
  })
})

describe('saveEntry', () => {
  it('PATCHes media only when fileId is provided (update)', async () => {
    const meta = { id: 'file-1', name: 'diary-2026-05-01.md', version: '2' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: 'updated', updated_at: '2026-05-01T00:00:00.000Z' }

    const result = await saveEntry('token', entry, 'folder-1', 'file-1')

    expect(result.version).toBe('2')
    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    expect(fetchCall[0]).toContain('/files/file-1')
    expect(fetchCall[0]).toContain('uploadType=media')
    expect(fetchCall[1].method).toBe('PATCH')
    expect(fetchCall[1].headers['Content-Type']).toBe('text/plain; charset=UTF-8')
    expect(fetchCall[1].body).toBe('updated')
  })

  it('sends If-Match header when ifMatch is provided', async () => {
    const meta = { id: 'file-1', name: 'diary-2026-05-01.md', version: '3' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: 'updated', updated_at: '2026-05-01T00:00:00.000Z' }

    await saveEntry('token', entry, null, 'file-1', '2')

    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    expect(fetchCall[1].headers['If-Match']).toBe('2')
  })

  it('omits If-Match header when ifMatch is not provided', async () => {
    const meta = { id: 'file-1', name: 'diary-2026-05-01.md', version: '3' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: 'updated', updated_at: '2026-05-01T00:00:00.000Z' }

    await saveEntry('token', entry, null, 'file-1')

    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    expect(fetchCall[1].headers['If-Match']).toBeUndefined()
  })

  it('throws DriveConflictError on 412', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Precondition Failed', { status: 412 })))
    const entry = { date: '2026-05-01', content: 'updated', updated_at: '2026-05-01T00:00:00.000Z' }

    await expect(saveEntry('token', entry, null, 'file-1', '2')).rejects.toBeInstanceOf(DriveConflictError)
  })

  it('POSTes when no fileId (create)', async () => {
    const meta = { id: 'new-file', name: 'diary-2026-05-01.md', version: '1' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: 'new', updated_at: '2026-05-01T00:00:00.000Z' }

    const result = await saveEntry('token', entry, 'folder-1')

    expect(result.version).toBe('1')
    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    expect(fetchCall[0]).toContain('/files?uploadType=multipart')
    expect(fetchCall[1].method).toBe('POST')
  })

  it('throws when folderId is null and no fileId is provided (create)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const entry = { date: '2026-05-01', content: 'x', updated_at: '' }
    await expect(saveEntry('token', entry, null)).rejects.toThrow(/folderId is required/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('builds multipart body with boundary', async () => {
    const meta = { id: 'f', name: 'diary-2026-05-01.json', version: '1' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: 'test', updated_at: '2026-05-01T00:00:00.000Z' }

    await saveEntry('token', entry, 'folder-1')

    const fetchCall = (vi.mocked(fetch).mock.calls[0] as any)
    const contentType = fetchCall[1].headers['Content-Type']
    expect(contentType).toContain('multipart/related')
    expect(contentType).toContain('boundary=linger_boundary')
    expect(fetchCall[1].body).toContain('linger_boundary')
  })
})

describe('deleteEntry', () => {
  it('sends DELETE request and returns void', async () => {
    const delFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', delFetch)

    await deleteEntry('token', 'file-1')

    const call = delFetch.mock.calls[0] as any
    expect(call[0]).toContain('/files/file-1')
    expect(call[1].method).toBe('DELETE')
  })
})

describe('listRevisions', () => {
  it('returns revisions in reverse order (newest first)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      driveJsonResponse({ revisions: [{ id: '1' }, { id: '2' }, { id: '3' }] })))

    const result = await listRevisions('token', 'file-1')

    expect(result).toHaveLength(3)
    expect(result[0].id).toBe('3')
    expect(result[2].id).toBe('1')
  })

  it('returns empty array when there are no revisions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      driveJsonResponse({ revisions: [] })))

    const result = await listRevisions('token', 'file-1')
    expect(result).toEqual([])
  })
})

describe('getRevisionContent', () => {
  it('fetches revision content with alt=media', async () => {
    const entry = { date: '2026-05-01', content: 'rev' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(driveMarkdownResponse(entry)))

    const result = await getRevisionContent('token', 'file-1', 'rev-1')
    expect(result).toEqual(entry)
  })
})

const sessionWithFolder = () => ({ refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 3_600_000, folder_id: 'folder-1' })
const envStub = { SESSIONS: { put: vi.fn() } } as any

describe('listEntries pagination', () => {
  it('uses pageSize=100 and orderBy=name', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      urls.push(String(input))
      return driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.md', version: '1' }] })
    }))

    await listEntries('tok', 'sid', sessionWithFolder(), envStub)

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('pageSize=100')
    expect(urls[0]).toContain('orderBy=name')
  })

  it('follows nextPageToken until exhausted and concatenates all files', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      urls.push(String(input))
      if (urls.length === 1) {
        return driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.md', version: '1' }], nextPageToken: 'page-2' })
      }
      if (urls.length === 2) {
        return driveJsonResponse({ files: [{ id: 'f2', name: 'diary-2026-05-02.md', version: '1' }], nextPageToken: 'page-3' })
      }
      return driveJsonResponse({ files: [{ id: 'f3', name: 'diary-2026-05-03.md', version: '1' }] })
    }))

    const files = await listEntries('tok', 'sid', sessionWithFolder(), envStub)

    expect(files.map(f => f.id)).toEqual(['f1', 'f2', 'f3'])
    expect(urls).toHaveLength(3)
    expect(urls[1]).toContain('pageToken=page-2')
    expect(urls[2]).toContain('pageToken=page-3')
  })
})

describe('migrateMdToTxt', () => {
  it('renames only legacy .md diary files to .txt and returns the count', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const url = String(input)
      calls.push({ url, method: init?.method, body: init?.body })
      if (url.includes('q=')) {
        return driveJsonResponse({ files: [
          { id: 'f1', name: 'diary-2026-05-01.md', version: '1' },
          { id: 'f2', name: 'diary-2026-05-02.txt', version: '1' },
          { id: 'f3', name: 'diary-2026-05-03.md', version: '1' },
        ] })
      }
      return driveJsonResponse({ id: 'patched' })
    }))

    const migrated = await migrateMdToTxt('tok', 'sid', sessionWithFolder(), envStub)

    expect(migrated).toBe(2)
    const patches = calls.filter(c => c.method === 'PATCH')
    expect(patches).toHaveLength(2)
    expect(patches[0].url).toContain('/files/f1')
    expect(JSON.parse(patches[0].body!)).toEqual({ name: 'diary-2026-05-01.txt' })
    expect(patches[1].url).toContain('/files/f3')
    expect(JSON.parse(patches[1].body!)).toEqual({ name: 'diary-2026-05-03.txt' })
  })

  it('returns 0 and issues no renames when nothing is legacy', async () => {
    const methods: (string | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init: any) => {
      methods.push(init?.method)
      return driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.txt', version: '1' }] })
    }))

    const migrated = await migrateMdToTxt('tok', 'sid', sessionWithFolder(), envStub)

    expect(migrated).toBe(0)
    expect(methods.some(m => m === 'PATCH')).toBe(false)
  })
})

describe('getStartPageToken', () => {
  it('returns the start page token from the changes endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      expect(String(input)).toContain('/changes/startPageToken')
      return driveJsonResponse({ startPageToken: 'tok-123' })
    }))

    const token = await getStartPageToken('tok')
    expect(token).toBe('tok-123')
  })
})

describe('getChanges', () => {
  it('returns changes and newStartPageToken on the happy path', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      urls.push(String(input))
      return driveJsonResponse({
        changes: [
          { fileId: 'f1', removed: false, file: { id: 'f1', name: 'diary-2026-05-01.md', version: '2' } },
          { fileId: 'f2', removed: true },
        ],
        newStartPageToken: 'tok-next',
      })
    }))

    const result = await getChanges('tok', 'tok-start')

    expect(result.newStartPageToken).toBe('tok-next')
    expect(result.changes).toHaveLength(2)
    expect(result.changes[0]).toMatchObject({ fileId: 'f1', removed: false })
    expect(result.changes[1]).toMatchObject({ fileId: 'f2', removed: true })
    expect(urls[0]).toContain('pageToken=tok-start')
    expect(urls[0]).toContain('restrictToMyDrive=true')
    expect(urls[0]).toContain('includeItemsFromAllDrives=false')
  })

  it('paginates through nextPageToken and returns the final newStartPageToken', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      urls.push(String(input))
      if (urls.length === 1) {
        return driveJsonResponse({
          changes: [{ fileId: 'f1', removed: false, file: { id: 'f1', name: 'diary-2026-05-01.md', version: '1' } }],
          nextPageToken: 'page-2',
        })
      }
      return driveJsonResponse({
        changes: [{ fileId: 'f2', removed: false, file: { id: 'f2', name: 'diary-2026-05-02.md', version: '1' } }],
        newStartPageToken: 'tok-final',
      })
    }))

    const result = await getChanges('tok', 'tok-start')

    expect(result.changes.map(c => c.fileId)).toEqual(['f1', 'f2'])
    expect(result.newStartPageToken).toBe('tok-final')
    expect(urls[1]).toContain('pageToken=page-2')
  })
})
