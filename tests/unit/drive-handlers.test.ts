import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as onSearch } from '../../functions/api/drive/search'
import { onRequestGet as onListEntries } from '../../functions/api/drive/entries'
import { onRequestGet as onGetEntry, onRequestPost as onPostEntry, onRequestDelete as onDeleteEntry } from '../../functions/api/drive/entry/[date]'
import { onRequestGet as onListRevisions } from '../../functions/api/drive/revisions/[fileId]'
import { onRequestGet as onGetRevision } from '../../functions/api/drive/revisions/[fileId]/[revisionId]'
import { onRequestGet as onChanges } from '../../functions/api/drive/changes'
import { onRequestGet as onGetMilestones, onRequestPut as onPutMilestones } from '../../functions/api/drive/milestones'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  mirrorEntrySave: vi.fn().mockResolvedValue(undefined),
  mirrorEntryDelete: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  listEntries: vi.fn().mockResolvedValue([]),
  searchEntries: vi.fn().mockResolvedValue([{ id: 'f1' }]),
  findEntryMeta: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '7' }),
  getEntryContent: vi.fn().mockResolvedValue({ date: '2026-05-01', content: 'hi', updated_at: '' }),
  getEntryMeta: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '8' }),
  getDiaryFileMeta: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '8' }),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  saveEntry: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '9' }),
  listRevisions: vi.fn().mockResolvedValue([]),
  getRevisionContent: vi.fn().mockResolvedValue({ date: '2026-05-01', content: 'hi', updated_at: '' }),
  getStartPageToken: vi.fn().mockResolvedValue('tok-init'),
  getChanges: vi.fn().mockResolvedValue({ changes: [{ fileId: 'f1', removed: false }], newStartPageToken: 'tok-next' }),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn().mockResolvedValue([]),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'milestones-file', name: 'milestones.json' }),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
}))

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/'),
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    waitUntil: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('list entries handler', () => {
  it('fetches start page token in parallel with listing entries', async () => {
    let listResolves: (() => void) | undefined
    let tokenResolves: (() => void) | undefined
    const listStarted = vi.fn()
    const tokenStarted = vi.fn()

    vi.mocked(drive.listEntries).mockImplementationOnce(() => {
      listStarted()
      return new Promise(resolve => { listResolves = () => resolve([{ id: 'f1', name: 'diary-2026-05-01.txt', version: '1' }]) })
    })
    vi.mocked(drive.getStartPageToken).mockImplementationOnce(() => {
      tokenStarted()
      return new Promise(resolve => { tokenResolves = () => resolve('tok-fresh') })
    })

    const put = vi.fn()
    const ctx = makeContext({ env: { SESSIONS: { put } } })
    const resPromise = onListEntries(ctx as any)

    // Both calls should have started before either resolves
    expect(listStarted).toHaveBeenCalledOnce()
    expect(tokenStarted).toHaveBeenCalledOnce()

    // Resolve both
    listResolves!()
    tokenResolves!()
    const res = await resPromise

    expect(res.status).toBe(200)
    const body = await res.json() as { files: unknown[] }
    expect(body.files).toHaveLength(1)
    expect(put).toHaveBeenCalledOnce()
  })

  it('still returns entries when getStartPageToken fails', async () => {
    vi.mocked(drive.getStartPageToken).mockRejectedValueOnce(new Error('token fetch failed'))

    const put = vi.fn()
    const ctx = makeContext({ env: { SESSIONS: { put } } })
    const res = await onListEntries(ctx as any)

    expect(res.status).toBe(200)
    const body = await res.json() as { files: unknown[] }
    expect(body.files).toEqual([])
    // Session should not be updated when token fetch fails
    expect(put).not.toHaveBeenCalled()
  })
})

describe('search handler', () => {
  it('returns empty array for blank query', async () => {
    const ctx = makeContext({ request: new Request('http://localhost/api/drive/search?q=') })
    const res = await onSearch(ctx as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [] })
  })

  it('returns empty array when query exceeds 500 characters', async () => {
    const q = 'a'.repeat(501)
    const ctx = makeContext({ request: new Request(`http://localhost/api/drive/search?q=${q}`) })
    const res = await onSearch(ctx as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [] })
  })

  it('accepts a query of exactly 500 characters', async () => {
    const q = 'a'.repeat(500)
    const ctx = makeContext({ request: new Request(`http://localhost/api/drive/search?q=${q}`) })
    const res = await onSearch(ctx as any)
    expect(res.status).toBe(200)
    const body = await res.json() as { files: unknown[] }
    expect(body.files).toHaveLength(1)
  })
})

describe('milestones handler', () => {
  it('returns the stored list from milestones.json', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValueOnce('milestones-file')
    vi.mocked(drive.readJsonFile).mockResolvedValueOnce([
      { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
    ])

    const res = await onGetMilestones(makeContext() as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
    ])
    expect(drive.readJsonFile).toHaveBeenCalledWith('tok', 'milestones-file')
  })

  it('falls back to anniversaries.json when milestones.json does not exist', async () => {
    vi.mocked(drive.findJsonFile)
      .mockResolvedValueOnce(null)           // milestones.json not found
      .mockResolvedValueOnce('legacy-file')  // anniversaries.json found
    vi.mocked(drive.readJsonFile).mockResolvedValueOnce([
      { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
    ])

    const res = await onGetMilestones(makeContext() as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: 'birthday', label: 'Birthday', date: '2020-05-10' },
    ])
    expect(drive.readJsonFile).toHaveBeenCalledWith('tok', 'legacy-file')
  })

  it('rejects impossible calendar dates', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: 'bad', label: 'Bad', date: '2026-02-30' }]),
      }),
    })

    const res = await onPutMilestones(ctx as any)

    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('rejects more than fifty milestones', async () => {
    const body = Array.from({ length: 51 }, (_, i) => ({
      id: `milestone-${i}`,
      label: `Milestone ${i}`,
      date: '2020-05-10',
      showBadge: false,
    }))
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    })

    const res = await onPutMilestones(ctx as any)

    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('rejects more than five enabled badges', async () => {
    const body = Array.from({ length: 6 }, (_, i) => ({
      id: `milestone-${i}`,
      label: `Milestone ${i}`,
      date: '2020-05-10',
    }))
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    })

    const res = await onPutMilestones(ctx as any)

    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('updates the existing Drive file with sanitized body', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValueOnce('milestones-file')
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: 'birthday', label: 'Birthday', date: '2020-05-10' }]),
      }),
    })

    const res = await onPutMilestones(ctx as any)

    expect(res.status).toBe(200)
    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok',
      'folder-1',
      'milestones.json',
      [{ id: 'birthday', label: 'Birthday', date: '2020-05-10' }],
      'milestones-file',
    )
  })

  it('deletes legacy anniversaries.json on first write to milestones.json', async () => {
    vi.mocked(drive.findJsonFile)
      .mockResolvedValueOnce(null)           // milestones.json not found (first PUT call)
      .mockResolvedValueOnce('legacy-file')  // anniversaries.json found
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: 'birthday', label: 'Birthday', date: '2020-05-10' }]),
      }),
    })

    await onPutMilestones(ctx as any)

    expect(drive.deleteEntry).toHaveBeenCalledWith('tok', 'legacy-file')
  })

  it('rejects an empty label', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: 'a', label: '   ', date: '2020-05-10' }]),
      }),
    })
    const res = await onPutMilestones(ctx as any)
    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('rejects a label exceeding 100 characters', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: 'a', label: 'x'.repeat(101), date: '2020-05-10' }]),
      }),
    })
    const res = await onPutMilestones(ctx as any)
    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('rejects an empty id', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/milestones', {
        method: 'PUT',
        body: JSON.stringify([{ id: '  ', label: 'Birthday', date: '2020-05-10' }]),
      }),
    })
    const res = await onPutMilestones(ctx as any)
    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('returns [] when the stored file contains corrupted JSON', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValueOnce('milestones-file')
    vi.mocked(drive.readJsonFile).mockRejectedValueOnce(new SyntaxError('Unexpected token'))

    const res = await onGetMilestones(makeContext() as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns [] when the stored file contains valid JSON that is not an array', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValueOnce('milestones-file')
    vi.mocked(drive.readJsonFile).mockResolvedValueOnce({ unexpected: true })

    const res = await onGetMilestones(makeContext() as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('get entry handler', () => {
  it('returns the meta from the date lookup without an extra Drive metadata fetch', async () => {
    const ctx = makeContext({ params: { date: '2026-05-01' } })
    const res = await onGetEntry(ctx as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      entry: { content: 'hi' },
      meta: { id: 'entry-1', version: '7' },
    })
    expect(drive.findEntryMeta).toHaveBeenCalledOnce()
    expect(drive.getEntryContent).toHaveBeenCalledWith('tok', 'entry-1', '2026-05-01')
    expect(drive.getEntryMeta).not.toHaveBeenCalled()
  })

  it('validates a provided fileId against the diary folder and date before reading', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01?fileId=validFileId1234567890'),
      params: { date: '2026-05-01' },
    })
    const res = await onGetEntry(ctx as any)

    expect(res.status).toBe(200)
    expect(drive.getDiaryFileMeta).toHaveBeenCalledWith(
      'tok',
      'sid',
      {},
      {},
      'validFileId1234567890',
      '2026-05-01',
    )
  })
})

describe('post entry handler', () => {
  it('rejects oversized entries', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({ content: 'a'.repeat(500_001) }),
      }),
      params: { date: '2026-05-01' },
    })

    const res = await onPostEntry(ctx as any)

    expect(res.status).toBe(413)
  })

  it('validates the current Drive file before saving when fileId is known and baseVersion is provided', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({ content: 'updated', fileId: 'validFileId1234567890', baseVersion: '8' }),
      }),
      params: { date: '2026-05-01' },
    })

    const res = await onPostEntry(ctx as any)

    expect(res.status).toBe(200)
    expect(drive.getDiaryFileMeta).toHaveBeenCalledWith(
      'tok',
      'sid',
      {},
      {},
      'validFileId1234567890',
      '2026-05-01',
    )
    expect(drive.saveEntry).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ date: '2026-05-01', content: 'updated' }),
      'folder-1',
      'entry-1',
    )
    expect(drive.getEntryContent).not.toHaveBeenCalled()
  })

  it('skips conflict fetch when current Drive version still matches baseVersion', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({ content: 'updated', fileId: 'validFileId1234567890', baseVersion: '8' }),
      }),
      params: { date: '2026-05-01' },
    })

    const res = await onPostEntry(ctx as any)

    expect(res.status).toBe(200)
    expect(drive.getDiaryFileMeta).toHaveBeenCalledOnce()
    expect(drive.getEntryContent).not.toHaveBeenCalled()
    expect(drive.saveEntry).toHaveBeenCalledWith(
      'tok',
      expect.any(Object),
      'folder-1',
      'entry-1',
    )
  })

  it('returns a conflict without saving when current Drive content differs from baseContent', async () => {
    vi.mocked(drive.getDiaryFileMeta).mockResolvedValueOnce({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '9' })
    vi.mocked(drive.getEntryContent).mockResolvedValueOnce({ date: '2026-05-01', content: 'remote edit' })
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({
          content: 'updated',
          fileId: 'validFileId1234567890',
          baseVersion: '8',
          baseContent: 'local base',
        }),
      }),
      params: { date: '2026-05-01' },
    })

    const res = await onPostEntry(ctx as any)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      conflict: {
        entry: { content: 'remote edit' },
        meta: { version: '9' },
      },
    })
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('falls through to legacy path when fileId is provided but baseVersion is null', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({ content: 'updated', fileId: 'validFileId1234567890', baseVersion: null }),
      }),
      params: { date: '2026-05-01' },
    })
    const res = await onPostEntry(ctx as any)
    // Legacy path: remote file exists (version '7') but client has no version → 409 conflict.
    // Before the fix this silently PATCHed via the optimistic path with no If-Match.
    expect(res.status).toBe(409)
    expect(drive.findEntryMeta).toHaveBeenCalledOnce()
    expect(drive.getDiaryFileMeta).not.toHaveBeenCalled()
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('saves when current Drive version changed but remote content still matches baseContent', async () => {
    vi.mocked(drive.getDiaryFileMeta).mockResolvedValueOnce({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '9' })
    vi.mocked(drive.getEntryContent).mockResolvedValueOnce({ date: '2026-05-01', content: 'local base' })
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({
          content: 'updated',
          fileId: 'validFileId1234567890',
          baseVersion: '8',
          baseContent: 'local base',
        }),
      }),
      params: { date: '2026-05-01' },
    })

    const res = await onPostEntry(ctx as any)

    expect(res.status).toBe(200)
    expect(drive.getEntryContent).toHaveBeenCalledWith('tok', 'entry-1', '2026-05-01')
    expect(drive.saveEntry).toHaveBeenCalledOnce()
    expect(drive.saveEntry).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ date: '2026-05-01', content: 'updated' }),
      'folder-1',
      'entry-1',
    )
  })

  it('passes the saved Drive version through to mirrorEntrySave for S3 ordering', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        body: JSON.stringify({ content: 'updated', fileId: 'validFileId1234567890', baseVersion: '8' }),
      }),
      params: { date: '2026-05-01' },
    })

    await onPostEntry(ctx as any)

    expect(s3Settings.mirrorEntrySave).toHaveBeenCalledWith('tok', 'sid', {}, {}, '2026-05-01', 'updated', 'entry-1', '9')
  })
})

describe('delete entry handler', () => {
  it('mirrors the delete to S3 after removing the Drive file', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', { method: 'DELETE' }),
      params: { date: '2026-05-01' },
    })

    const res = await onDeleteEntry(ctx as any)

    expect(res.status).toBe(204)
    expect(drive.deleteEntry).toHaveBeenCalledWith('tok', 'entry-1')
    expect(s3Settings.mirrorEntryDelete).toHaveBeenCalledWith('tok', 'sid', {}, {}, '2026-05-01')
  })
})

describe('list revisions handler', () => {
  it('rejects fileId shorter than 10 characters', async () => {
    const ctx = makeContext({ params: { fileId: 'short' } })
    const res = await onListRevisions(ctx as any)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Invalid file ID' })
  })

  it('rejects fileId with invalid characters', async () => {
    const ctx = makeContext({ params: { fileId: 'invalid/file/id!!' } })
    const res = await onListRevisions(ctx as any)
    expect(res.status).toBe(400)
  })

  it('accepts a valid fileId', async () => {
    const ctx = makeContext({ params: { fileId: 'validFileId1234567890' } })
    const res = await onListRevisions(ctx as any)
    expect(res.status).toBe(200)
  })
})

describe('changes handler', () => {
  function changesContext(session: Record<string, unknown>) {
    const put = vi.fn()
    const ctx = {
      request: new Request('http://localhost/api/drive/changes'),
      data: { accessToken: 'tok', sessionId: 'sid', session },
      env: { SESSIONS: { put } },
    }
    return { ctx, put }
  }

  it('initialises the start page token and returns empty changes when none is stored', async () => {
    const session: Record<string, unknown> = {}
    const { ctx, put } = changesContext(session)

    const res = await onChanges(ctx as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changes: [], newStartPageToken: 'tok-init' })
    expect(drive.getStartPageToken).toHaveBeenCalledOnce()
    expect(drive.getChanges).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledOnce()
  })

  it('returns changes and persists newStartPageToken when a token is stored', async () => {
    const session: Record<string, unknown> = { changes_start_page_token: 'tok-old' }
    const { ctx, put } = changesContext(session)

    const res = await onChanges(ctx as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changes: [{ fileId: 'f1', removed: false }], newStartPageToken: 'tok-next' })
    expect(drive.getChanges).toHaveBeenCalledWith('tok', 'tok-old')
    expect(put).toHaveBeenCalledOnce()
  })

  it('resets the token and returns empty changes when the stored token is stale (400)', async () => {
    vi.mocked(drive.getChanges).mockRejectedValueOnce(new drive.DriveError(400, 'Invalid pageToken'))
    const session: Record<string, unknown> = { changes_start_page_token: 'tok-stale' }
    const { ctx } = changesContext(session)

    const res = await onChanges(ctx as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changes: [], newStartPageToken: 'tok-init' })
    expect(drive.getStartPageToken).toHaveBeenCalledOnce()
  })
})

describe('get revision content handler', () => {
  it('rejects fileId shorter than 10 characters', async () => {
    const ctx = makeContext({ params: { fileId: 'short', revisionId: 'rev1' } })
    const res = await onGetRevision(ctx as any)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Invalid file ID' })
  })

  it('rejects revisionId with invalid characters', async () => {
    const ctx = makeContext({ params: { fileId: 'validFileId1234567890', revisionId: 'bad/rev' } })
    const res = await onGetRevision(ctx as any)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Invalid revision ID' })
  })

  it('accepts valid fileId and revisionId', async () => {
    const ctx = makeContext({ params: { fileId: 'validFileId1234567890', revisionId: 'rev-1' } })
    const res = await onGetRevision(ctx as any)
    expect(res.status).toBe(200)
  })
})
