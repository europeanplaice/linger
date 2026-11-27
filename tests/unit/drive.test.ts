import { describe, expect, it, vi, afterEach } from 'vitest'
import { encodeVaultBytes } from '../../functions/_shared/vaultCrypto'
import {
  inspectDriveFolder, ensureFolder, getEntryContent, saveEntry, trashEntry, generateFileId,
  listRevisions, getRevisionContent, getDiaryFileMeta, describeDriveError, DriveError, DriveConflictError,
  listEntries, getStartPageToken, getChanges, migrateMdToTxt, findJsonFile,
  beginEntryUpload, entryUploadStatus,
} from '../../functions/_shared/drive'

vi.mock('../../functions/_shared/session', async importOriginal => ({
  ...await importOriginal<typeof import('../../functions/_shared/session')>(),
  saveSession: vi.fn(async () => {}),
}))

const testUserId = `drive-test-user-${crypto.randomUUID()}`
const testVaultKey = encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))

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

  it('maps DriveError to fixed safe messages without leaking upstream bodies', () => {
    expect(describeDriveError(new DriveError(403, '{"error":"secret upstream info"}'))).toBe('Google Drive access denied')
    expect(describeDriveError(new DriveError(502, 'raw backend trace'))).toBe('Google Drive temporarily unavailable')
    expect(describeDriveError(new DriveError(404, 'missing'))).toBe('not_found')
  })
})

describe('findJsonFile', () => {
  it('returns the matching file id', async () => {
    mockFetch(driveJsonResponse({ files: [{ id: 'anniversaries-file' }] }))

    await expect(findJsonFile('token', 'folder-1', 'anniversaries.json'))
      .resolves.toBe('anniversaries-file')
  })

  it('propagates Drive errors instead of treating them as a missing file', async () => {
    mockFetch(new Response('Forbidden', { status: 403 }))

    await expect(findJsonFile('token', 'folder-1', 'anniversaries.json'))
      .rejects.toMatchObject({ name: 'DriveError', status: 403 })
  })

  it('escapes single quotes in fileName', async () => {
    const fetchMock = vi.fn().mockResolvedValue(driveJsonResponse({ files: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await findJsonFile('token', 'folder-1', "it's.json")

    const url: string = fetchMock.mock.calls[0][0]
    const q = new URL(url).searchParams.get('q') ?? ''
    expect(q).toContain("name='it\\'s.json'")
  })

  it('escapes backslashes in fileName', async () => {
    const fetchMock = vi.fn().mockResolvedValue(driveJsonResponse({ files: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await findJsonFile('token', 'folder-1', 'back\\slash.json')

    const url: string = fetchMock.mock.calls[0][0]
    const q = new URL(url).searchParams.get('q') ?? ''
    expect(q).toContain("name='back\\\\slash.json'")
  })
})

describe('ensureFolder', () => {
  it('returns cached folder_id from session', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'cached' }
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } }
    const result = await ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true })
    expect(result).toBe('cached')
  })

  it('uses the account coordinator even when the session has a stale cached folder id', async () => {
    const service = { ensureDiaryFolder: vi.fn().mockResolvedValue('account-folder') }
    const put = vi.fn()
    const env = {
      SESSIONS: { get: vi.fn().mockResolvedValue(null), put },
      SESSION_DOMAIN: 'https://linger.europeanplaice.com',
      S3_WORKFLOW_SERVICE: service,
    }
    const session: any = {
      refresh_token: 'rt', access_token: 'at', expires_at: 1000,
      user_id: testUserId, vault_key: testVaultKey, google_sub: 'google-user', folder_id: 'stale-device-folder',
      s3_settings_file_id: 'old-settings', s3_status_file_id: 'old-status',
      s3_settings_negative_cache_at: Date.now(), s3_status_negative_cache_at: Date.now(),
    }

    const result = await ensureFolder('token', 'sid', session, env as any)

    expect(service.ensureDiaryFolder).toHaveBeenCalledWith({
      sessionId: 'sid', accountKey: testUserId, vaultKey: testVaultKey, accessToken: 'token', expiresAt: 1000, idToken: undefined,
    })
    expect(result).toBe('account-folder')
    expect(session.folder_id).toBe('account-folder')
    expect(session).toMatchObject({
      s3_settings_file_id: undefined,
      s3_status_file_id: undefined,
      s3_settings_negative_cache_at: undefined,
      s3_status_negative_cache_at: undefined,
    })
    expect(put).not.toHaveBeenCalled()
  })

  it('fails closed when the account coordinator is unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'google-user' }
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }

    await expect(ensureFolder('token', 'sid', session, env as any)).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the Workflow Worker DiaryWriter binding when no Pages service binding exists', async () => {
    const ensureDiaryFolder = vi.fn().mockResolvedValue('worker-account-folder')
    const getByName = vi.fn().mockReturnValue({ ensureFolder: ensureDiaryFolder })
    const session: any = {
      refresh_token: 'rt', access_token: 'at', expires_at: 1000,
      user_id: testUserId, vault_key: testVaultKey, google_sub: 'google-user', folder_id: 'stale-device-folder',
    }
    const env = {
      SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
      DIARY_WRITER: { getByName },
    }

    const result = await ensureFolder('token', 'sid', session, env as any)

    expect(getByName).toHaveBeenCalledWith(testUserId)
    expect(ensureDiaryFolder).toHaveBeenCalledWith({
      sessionId: 'sid', accountKey: testUserId, vaultKey: testVaultKey, accessToken: 'token', expiresAt: 1000, idToken: undefined,
    })
    expect(result).toBe('worker-account-folder')
    expect(session.folder_id).toBe('worker-account-folder')
  })

  it('fails closed when the session has no account identity', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }

    await expect(ensureFolder('token', 'sid', session, env as any)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects ambiguous existing diary folders instead of picking an arbitrary one', async () => {
    mockFetch(driveJsonResponse({ files: [{ id: 'folder-a' }, { id: 'folder-b' }] }))
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    await expect(ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('rejects a cached folder id that conflicts with the unique named folder during account discovery', async () => {
    mockFetch(driveJsonResponse({ files: [{ id: 'named-folder' }] }))
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, folder_id: 'different-folder' }

    await expect(ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true, discoverByName: true }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('follows short and empty pages before accepting a unique folder', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [], nextPageToken: 'empty/page' }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'only-folder' }], nextPageToken: 'last/page' }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    await expect(ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true }))
      .resolves.toBe('only-folder')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('pageToken')).toBe('empty/page')
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('pageToken')).toBe('last/page')
  })

  it('rejects duplicate folders found on separate pages without persisting a choice', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'folder-a' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'folder-b' }] })))
    const put = vi.fn()
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    await expect(ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true }))
      .rejects.toMatchObject({ status: 409 })
    expect(put).not.toHaveBeenCalled()
  })

  it('finds existing folder on Drive', async () => {
    mockFetch(driveJsonResponse({ files: [{ id: 'existing-folder' }] }))
    const put = vi.fn()
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true })

    expect(result).toBe('existing-folder')
    expect(session.folder_id).toBe('existing-folder')
    expect(put).not.toHaveBeenCalled()
  })

  it('creates folder when none exists on Drive', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [] }))
      .mockResolvedValueOnce(driveJsonResponse({ id: 'new-folder' })))
    const put = vi.fn()
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put }, SESSION_DOMAIN: 'https://linger.europeanplaice.com' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true })
    expect(result).toBe('new-folder')
  })

  it('uses a staging-specific folder name on the staging domain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [] }))
      .mockResolvedValueOnce(driveJsonResponse({ id: 'staging-folder' }))
    vi.stubGlobal('fetch', fetchMock)
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'https://staging.linger.europeanplaice.com' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true })

    expect(result).toBe('staging-folder')
    const searchUrl: string = fetchMock.mock.calls[0][0]
    const q = new URL(searchUrl).searchParams.get('q') ?? ''
    expect(q).toContain("name='linger_diary_staging'")
    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(createBody.name).toBe('linger_diary_staging')
  })

  it('uses a dev-specific folder name on the local domain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ files: [] }))
      .mockResolvedValueOnce(driveJsonResponse({ id: 'dev-folder' }))
    vi.stubGlobal('fetch', fetchMock)
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() }, SESSION_DOMAIN: 'http://localhost:8788' }
    const session: any = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }

    const result = await ensureFolder('token', 'sid', session, env as any, { withinCoordinator: true })

    expect(result).toBe('dev-folder')
    const searchUrl: string = fetchMock.mock.calls[0][0]
    const q = new URL(searchUrl).searchParams.get('q') ?? ''
    expect(q).toContain("name='linger_diary_dev'")
    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(createBody.name).toBe('linger_diary_dev')
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

  it('preserves ordinary Markdown separators instead of discarding diary text', async () => {
    const raw = '---\nnot really frontmatter\n---\nrest of entry'
    mockFetch(new Response(raw, { status: 200, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } }))

    const result = await getEntryContent('token', 'file-123', '2026-05-01')
    expect(result.date).toBe('2026-05-01')
    expect(result.content).toBe(raw)
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
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' }

    const result = await getDiaryFileMeta('token', 'sid', session, envStub, 'file-1', '2026-05-01')

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
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, envStub, 'file-1', '2026-05-01'))
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
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' }

    const result = await getDiaryFileMeta('token', 'sid', session, envStub, 'file-1', '2026-05-01')

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
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, envStub, 'file-1', '2026-05-01'))
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
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' }

    await expect(getDiaryFileMeta('token', 'sid', session, envStub, 'file-1', '2026-05-01'))
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

  it('builds multipart body with a per-request random boundary', async () => {
    const meta = { id: 'f', name: 'diary-2026-05-01.json', version: '1' }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => driveJsonResponse(meta)))
    const entry = { date: '2026-05-01', content: '--linger_boundary\n--linger_boundary--', updated_at: '2026-05-01T00:00:00.000Z' }

    await saveEntry('token', entry, 'folder-1')
    await saveEntry('token', entry, 'folder-1')

    const calls = vi.mocked(fetch).mock.calls as any[]
    const ct1 = calls[0][1].headers['Content-Type'] as string
    const ct2 = calls[1][1].headers['Content-Type'] as string
    expect(ct1).toContain('multipart/related')
    expect(ct1).toMatch(/boundary=linger_boundary_[0-9a-f]{32}/)
    expect(ct2).toMatch(/boundary=linger_boundary_[0-9a-f]{32}/)
    expect(ct1).not.toBe(ct2)
    expect(calls[0][1].body).toContain('linger_boundary')
  })
})

describe('recoverable diary deletion and idempotent creation', () => {
  it('moves a diary file to the trash instead of permanently deleting it', async () => {
    mockFetch(driveJsonResponse({ id: 'file-1', trashed: true }))
    await trashEntry('token', 'file-1')
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/files/file-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ trashed: true })
  })

  it('requests a Drive-generated ID and includes it in the create metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ ids: ['reserved-id'] }))
      .mockResolvedValueOnce(driveJsonResponse({ id: 'reserved-id', version: '1' }))
    vi.stubGlobal('fetch', fetchMock)
    const id = await generateFileId('token')
    await saveEntry('token', { date: '2026-10-31', content: 'retained' }, 'folder-1', undefined, undefined, id)
    expect(fetchMock.mock.calls[0][0]).toContain('/files/generateIds?')
    expect(fetchMock.mock.calls[1][1].body).toContain('"id":"reserved-id"')
  })
})

describe('Drive resumable diary upload', () => {
  it.each([true, false])('initiates a metadata-only upload (create=%s)', async create => {
    const path = create ? '/files' : '/files/reserved-id'
    const location = `https://www.googleapis.com/upload/drive/v3${path}?uploadType=resumable&upload_id=temporary`
    mockFetch(new Response(null, { headers: { Location: location } }))

    await expect(beginEntryUpload('token', 'https://linger.example', '2026-10-31', 'folder-1', 'reserved-id', create, 7))
      .resolves.toBe(location)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain(`${path}?uploadType=resumable`)
    expect(init?.method).toBe(create ? 'POST' : 'PATCH')
    expect(init?.headers).toMatchObject({ Origin: 'https://linger.example', 'X-Upload-Content-Length': '7' })
    expect(JSON.parse(String(init?.body))).toEqual(create
      ? { id: 'reserved-id', name: 'diary-2026-10-31.txt', mimeType: 'text/plain', parents: ['folder-1'] }
      : {})
  })

  it('probes an upload without sending the text or Google credentials', async () => {
    mockFetch(new Response(null, { status: 308 }))
    const url = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=temporary'
    await expect(entryUploadStatus(url, 42)).resolves.toBe('incomplete')
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
      method: 'PUT', headers: { 'Content-Range': 'bytes */42' }, redirect: 'manual',
    }))
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined()
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

const sessionWithFolder = () => ({ refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 3_600_000, user_id: testUserId, vault_key: testVaultKey, google_sub: 'test-user', folder_id: 'folder-1' })
const envStub = {
  SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
  S3_WORKFLOW_SERVICE: { ensureDiaryFolder: vi.fn().mockResolvedValue('folder-1') },
} as any

describe('listEntries pagination', () => {
  it('uses pageSize=1000 and orderBy=name', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      urls.push(String(input))
      return driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.md', version: '1' }] })
    }))

    await listEntries('tok', 'sid', sessionWithFolder(), envStub)

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('pageSize=1000')
    expect(urls[0]).toContain('orderBy=name')
  })

  it('reuses session.folder_id on reads without calling the coordinator unless Drive returns 404', async () => {
    const ensureDiaryFolder = vi.fn().mockResolvedValue('fresh-folder')
    const env = {
      SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
      S3_WORKFLOW_SERVICE: { ensureDiaryFolder },
    } as any
    const session = sessionWithFolder()
    const fetchMock = vi.fn(async () => driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.txt', version: '1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await listEntries('tok', 'sid', session, env)
    expect(ensureDiaryFolder).not.toHaveBeenCalled()

    fetchMock
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'f2', name: 'diary-2026-05-02.txt', version: '1' }] }))

    const files = await listEntries('tok', 'sid', session, env)
    expect(ensureDiaryFolder).toHaveBeenCalledOnce()
    expect(files.map(f => f.id)).toEqual(['f2'])
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
  it('renames only legacy .md diary files to .txt and returns the migrated dates', async () => {
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

    expect(migrated).toEqual(['2026-05-01', '2026-05-03'])
    const patches = calls.filter(c => c.method === 'PATCH')
    expect(patches).toHaveLength(2)
    expect(patches[0].url).toContain('/files/f1')
    expect(JSON.parse(patches[0].body!)).toEqual({ name: 'diary-2026-05-01.txt' })
    expect(patches[1].url).toContain('/files/f3')
    expect(JSON.parse(patches[1].body!)).toEqual({ name: 'diary-2026-05-03.txt' })
  })

  it('returns an empty list and issues no renames when nothing is legacy', async () => {
    const methods: (string | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init: any) => {
      methods.push(init?.method)
      return driveJsonResponse({ files: [{ id: 'f1', name: 'diary-2026-05-01.txt', version: '1' }] })
    }))

    const migrated = await migrateMdToTxt('tok', 'sid', sessionWithFolder(), envStub)

    expect(migrated).toEqual([])
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


describe('diary folder inspection', () => {
  it('counts current and legacy diary files across pages without reading contents or writing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ id: 'folder', name: 'Journal', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true }, shared: false, ownedByMe: true }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'a', name: 'diary-2026-11-01.txt' }, { id: 'b', name: 'notes.txt' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [{ id: 'c', name: 'diary-2025-01-01.md' }, { id: 'd', name: 's3_settings.json' }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await inspectDriveFolder('token', 'folder')).toEqual({
      id: 'folder', name: 'Journal', canAddChildren: true, sharing: 'private', entryCount: 2,
      firstEntryDate: '2025-01-01', lastEntryDate: '2026-11-01', modifiedTime: undefined,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(init.method).toBeUndefined()
      expect(url).not.toContain('alt=media')
    }
    const listUrl = new URL(fetchMock.mock.calls[1][0])
    expect(listUrl.searchParams.get('q')).toBe("'folder' in parents and trashed=false and mimeType='text/plain'")
    expect(fetchMock.mock.calls[2][0]).toContain('pageToken=next')
  })

  it.each([
    [{ shared: true, ownedByMe: true }, 'shared'],
    [{ driveId: 'shared-drive' }, 'shared'],
    [{ ownedByMe: false, shared: false }, 'shared'],
    [{ ownedByMe: true, shared: false, permissions: [{ role: 'reader' }] }, 'shared'],
    [{ ownedByMe: true }, 'unknown'],
  ])('reports the exposed state for %j as %s', async (sharingFields, sharing) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ id: 'folder', name: 'Journal', mimeType: 'application/vnd.google-apps.folder', ...sharingFields }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [] })))
    expect(await inspectDriveFolder('token', 'folder')).toMatchObject({ sharing })
  })

  it.each([false, undefined])('does not assume write access when canAddChildren is %s', async canAddChildren => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(driveJsonResponse({ id: 'folder', name: 'Journal', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren } }))
      .mockResolvedValueOnce(driveJsonResponse({ files: [] })))
    expect(await inspectDriveFolder('token', 'folder')).toMatchObject({
      canAddChildren: false, entryCount: 0, firstEntryDate: null, lastEntryDate: null,
    })
  })

  it.each([
    { id: 'folder', mimeType: 'text/plain' },
    { id: 'folder', mimeType: 'application/vnd.google-apps.folder', trashed: true },
    { id: 'other', mimeType: 'application/vnd.google-apps.folder' },
  ])('rejects an unavailable folder before listing its contents', async meta => {
    mockFetch(driveJsonResponse(meta))
    await expect(inspectDriveFolder('token', 'folder')).rejects.toThrow('FOLDER_UNAVAILABLE')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
