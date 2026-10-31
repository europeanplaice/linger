import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeDiaryEntry, saveDiaryEntry, type EntryMutationContext } from '../../functions/_shared/entryMutation'
import type { DriveFileMeta } from '../../functions/_shared/drive'

// Exercise the real mutation handler AND Drive adapter. Only the HTTP boundary
// is mocked, so a mocked authorization helper cannot hide a wrong-file write.
const date = '2026-10-31'
const fileId = 'diary-file-0001'
const folderId = 'diary-folder-0001'
let meta: DriveFileMeta
let listing: DriveFileMeta[]
let nextPageToken: string | undefined
let readFailure: number | undefined
let writeFailure: number | undefined
let initialTrashed: boolean | undefined
let contents: Map<string, string>
let requests: { url: URL; method: string; body: unknown }[]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  meta = { id: fileId, name: `diary-${date}.txt`, version: '7', mimeType: 'text/plain', parents: [folderId] }
  listing = [meta]
  nextPageToken = undefined
  readFailure = undefined
  writeFailure = undefined
  contents = new Map([[fileId, 'original diary'], ['unrelated-file', 'untouched']])
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body })
    if (method === 'DELETE') throw new Error('Permanent Drive deletion is forbidden')
    if (method === 'GET') {
      if (readFailure) return json({ error: 'Drive unavailable' }, readFailure)
      if (url.pathname === '/drive/v3/files') return json({ files: listing, nextPageToken })
      if (url.pathname === `/drive/v3/files/${fileId}`) {
        return url.searchParams.get('alt') === 'media' ? new Response(contents.get(fileId)) : json(meta)
      }
    }
    if (method === 'PATCH' && url.pathname === `/upload/drive/v3/files/${fileId}`) {
      if (writeFailure) return json({ error: 'Write rejected' }, writeFailure)
      contents.set(fileId, String(init?.body))
      return json({ ...meta, version: '8' })
    }
    if (method === 'PATCH' && url.pathname === `/drive/v3/files/${fileId}`) {
      if (writeFailure) return json({ error: 'Write rejected' }, writeFailure)
      expect(JSON.parse(String(init?.body))).toEqual({ trashed: true })
      meta.trashed = true
      return json(meta)
    }
    throw new Error(`Unexpected Drive request: ${method} ${url.pathname}`)
  }))
})

afterEach(() => {
  // Applies to failures too: no path may fall back to permanent deletion.
  expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
  expect(contents.get('unrelated-file')).toBe('untouched')
  vi.unstubAllGlobals()
})

function context(method: 'POST' | 'DELETE', body?: unknown, headers?: HeadersInit): EntryMutationContext {
  initialTrashed = meta.trashed
  return {
    request: new Request('https://example.com/', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }),
    params: { date },
    data: {
      sessionId: 'session', accessToken: 'token',
      session: { access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000, folder_id: folderId },
    },
    env: {} as EntryMutationContext['env'],
    waitUntil: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined), onRemoved: vi.fn().mockResolvedValue(undefined),
  }
}

function expectNoMutation(ctx: EntryMutationContext) {
  expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  expect(contents.get(fileId)).toBe('original diary')
  expect(meta.trashed).toBe(initialTrashed)
  expect(ctx.onSaved).not.toHaveBeenCalled()
  expect(ctx.onRemoved).not.toHaveBeenCalled()
  expect(ctx.waitUntil).not.toHaveBeenCalled()
}

describe('Drive mutation safety at the HTTP boundary', () => {
  it.each([
    ['wrong folder', { parents: ['another-folder'] }],
    ['wrong date', { name: 'diary-2026-10-30.txt' }],
    ['non-diary file', { name: 'milestones.json' }],
    ['folder target', { mimeType: 'application/vnd.google-apps.folder' }],
    ['trashed file', { trashed: true }],
    ['missing parents', { parents: undefined }],
  ])('does not write to a %s, even with force enabled', async (_label, overrides) => {
    Object.assign(meta, overrides)
    const ctx = context('POST', { content: 'overwrite', fileId, baseVersion: '7', force: true })
    expect((await saveDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it.each([undefined, null, '6', ''])('does not overwrite a changed entry using version %s', async baseVersion => {
    const ctx = context('POST', { content: 'overwrite', fileId, baseVersion, baseContent: 'old content' })
    expect((await saveDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it('does not treat a missing server version and missing base version as a match', async () => {
    delete meta.version
    const ctx = context('POST', { content: 'overwrite', fileId })
    expect((await saveDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it('does not apply a stale file identity to a recreated entry with identical text', async () => {
    const ctx = context('POST', { content: 'overwrite', fileId: 'previous-file-id', baseVersion: null, baseContent: 'original diary' })
    expect((await saveDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it.each([false, true])('does not choose an arbitrary duplicate for %s force-save', async force => {
    listing.push({ ...meta, id: 'duplicate-file', name: `diary-${date}.md` })
    const ctx = context('POST', { content: 'overwrite', baseVersion: '7', force })
    expect((await saveDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it('does not delete when lookup is ambiguous, even if the first result matches', async () => {
    listing.push({ ...meta, id: 'duplicate-file' })
    const ctx = context('DELETE', undefined, { 'X-Linger-File-Id': fileId, 'If-Match': '7' })
    expect((await removeDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it('does not mutate when an additional lookup page might contain duplicates', async () => {
    nextPageToken = 'more-results'
    const ctx = context('DELETE', undefined, { 'X-Linger-File-Id': fileId, 'If-Match': '7' })
    expect((await removeDiaryEntry(ctx)).status).toBe(409)
    expectNoMutation(ctx)
  })

  it.each<Record<string, string>>([
    {}, { 'If-Match': '7' }, { 'X-Linger-File-Id': fileId },
    { 'X-Linger-File-Id': fileId, 'If-Match': '6' },
    { 'X-Linger-File-Id': 'previous-file', 'If-Match': '7' },
  ])('makes zero mutation calls for an incomplete or stale delete %j', async headers => {
    const ctx = context('DELETE', undefined, headers)
    expect([409, 428]).toContain((await removeDiaryEntry(ctx)).status)
    expectNoMutation(ctx)
  })

  it.each(['POST', 'DELETE'] as const)('does not fall back to a write after a %s metadata lookup fails', async method => {
    readFailure = 403
    const ctx = context(method, { content: 'overwrite', fileId, baseVersion: '7' }, { 'X-Linger-File-Id': fileId, 'If-Match': '7' })
    expect((await (method === 'POST' ? saveDiaryEntry(ctx) : removeDiaryEntry(ctx))).status).toBe(403)
    expectNoMutation(ctx)
  })

  it.each(['POST', 'DELETE'] as const)('does not schedule mirror changes after Drive rejects a %s', async method => {
    writeFailure = 403
    const ctx = context(method, { content: 'overwrite', fileId, baseVersion: '7' }, { 'X-Linger-File-Id': fileId, 'If-Match': '7' })
    expect((await (method === 'POST' ? saveDiaryEntry(ctx) : removeDiaryEntry(ctx))).status).toBe(403)
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(1)
    expect(contents.get(fileId)).toBe('original diary')
    expect(meta.trashed).not.toBe(true)
    expect(ctx.onSaved).not.toHaveBeenCalled()
    expect(ctx.onRemoved).not.toHaveBeenCalled()
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it.each([42, {}, true, '', 'bad/file/id'])('rejects an invalid file ID %j before contacting Drive', async invalidId => {
    const ctx = context('POST', { content: 'overwrite', fileId: invalidId, baseVersion: null })
    expect((await saveDiaryEntry(ctx)).status).toBe(400)
    expect(requests).toHaveLength(0)
    expectNoMutation(ctx)
  })

  it('updates exactly one authorized file and mirrors only after that write succeeds', async () => {
    const ctx = context('POST', { content: 'edited diary', fileId, baseVersion: '7' })
    expect((await saveDiaryEntry(ctx)).status).toBe(200)
    expect(requests.filter(request => request.method !== 'GET')).toEqual([
      { url: expect.objectContaining({ pathname: `/upload/drive/v3/files/${fileId}` }), method: 'PATCH', body: 'edited diary' },
    ])
    expect(contents.get(fileId)).toBe('edited diary')
    expect(ctx.onSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: fileId, version: '8' }))
    expect(ctx.onRemoved).not.toHaveBeenCalled()
  })

  it('trashes exactly the confirmed file once and preserves its body', async () => {
    const ctx = context('DELETE', undefined, { 'X-Linger-File-Id': fileId, 'If-Match': '7' })
    expect((await removeDiaryEntry(ctx)).status).toBe(204)
    expect(requests.filter(request => request.method !== 'GET')).toEqual([
      { url: expect.objectContaining({ pathname: `/drive/v3/files/${fileId}` }), method: 'PATCH', body: JSON.stringify({ trashed: true }) },
    ])
    expect(contents.get(fileId)).toBe('original diary')
    expect(ctx.onRemoved).toHaveBeenCalledOnce()
    expect(ctx.onSaved).not.toHaveBeenCalled()
  })
})
