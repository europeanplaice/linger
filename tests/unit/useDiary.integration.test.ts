import 'fake-indexeddb/auto'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntryConflictError, useDiary } from '../../src/hooks/useDiary'
import { TokenExpiredError } from '../../src/api/driveEntries'
import { clearCache as clearLegacyCache, getAllDrafts as getLegacyDrafts, deleteDraft as deleteLegacyDraft } from '../../src/lib/diaryCache'
import { clearCache, getAllCached } from '../../src/lib/secureCache'
import { SyncQueueManager } from '../../src/lib/syncQueue'
import { deleteDraft, getAllDrafts, putDraft } from '../../src/lib/draftStorage'
import { setActiveAccount } from '../../src/lib/accountSession'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import type { DriveChange, DriveFileMeta, LoadedDiaryEntry } from '../../src/types'

// Keep the Hook, API client, storage adapter and IDB cache real. Only the HTTP
// boundary is replaced; browser lifecycle/cross-tab tests remain in Playwright.
const date = '2026-05-01'
const email = 'user@example.com'
const meta = (day = date, version = '1'): DriveFileMeta => ({
  id: `file-${day}`, name: `diary-${day}.txt`, version,
})
const entry = (day = date, version = '1', content = 'hello') => ({
  entry: { date: day, content }, meta: meta(day, version),
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

let files: DriveFileMeta[]
let changes: DriveChange[]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let read: ReturnType<typeof vi.fn<(day: string) => Promise<Response>>>
let write: ReturnType<typeof vi.fn<(day: string, body: Record<string, unknown>) => Promise<Response>>>

beforeEach(async () => {
  await clearLegacyCache()
  for (const draft of await getLegacyDrafts()) await deleteLegacyDraft(draft.date, draft.owner)
  localStorage.clear()
  localStorage.setItem('linger_session_user', email)
  unlockVaultWithKey('test-vault', new Uint8Array(32).fill(5))
  setActiveAccount(`email:${encodeURIComponent(email)}`, false, email)
  await clearCache()
  await new SyncQueueManager(email).clear()
  for (const draft of await getAllDrafts(email)) await deleteDraft(draft.date, email)
  // Node's BroadcastChannel would connect unrelated jsdom tests. Actual tab
  // messaging is covered by tests/multitab.test.ts.
  vi.stubGlobal('BroadcastChannel', undefined)
  files = []
  changes = []
  read = vi.fn().mockImplementation(async () => json(null, 404))
  write = vi.fn().mockImplementation(async () => json({ error: 'unexpected write' }, 400))
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/drive/entries') return json({ files })
    if (url.pathname === '/api/drive/search') return json({ files })
    if (url.pathname === '/api/drive/changes') return json({ changes, newStartPageToken: 'tok-2' })
    if (url.pathname.startsWith('/api/drive/entry/')) {
      const day = url.pathname.split('/').pop()!
      return init?.method === 'POST' ? write(day, JSON.parse(String(init.body))) : read(day)
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  cleanup()
  // Drain outstanding IDB operations before clearing storage for the next case.
  await getAllCached()
  await getAllDrafts(email)
  vi.unstubAllGlobals()
  setActiveAccount(null)
  clearVaultKey()
})

async function start(initialFiles: DriveFileMeta[] = []) {
  files = initialFiles
  const onExpired = vi.fn()
  const onEvicted = vi.fn()
  const hook = renderHook(() => useDiary('signedIn', email, onExpired, onEvicted))
  await waitFor(() => expect(hook.result.current.freshListLoaded).toBe(true))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1 + Math.min(3, initialFiles.length)))
  await act(async () => {})
  expect(hook.result.current.error).toBeNull()
  fetchMock.mockClear()
  read.mockClear()
  onEvicted.mockClear()
  return { ...hook, onExpired, onEvicted }
}

describe('useDiary HTTP and storage integration', () => {
  it('does not delete a newer checkpoint with the same text after an older save finishes', async () => {
    const { result } = await start()
    const response = deferred<Response>()
    write.mockReturnValueOnce(response.promise)
    let pending!: Promise<LoadedDiaryEntry>
    act(() => { pending = result.current.save(date, 'same text', null) })
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    const previous = (await getAllDrafts(email))[0]
    await putDraft({ ...previous, savedAt: previous.savedAt + 1, baseVersion: 'newer-base' })
    await act(async () => { response.resolve(json(meta())); await pending })
    expect(await getAllDrafts(email)).toMatchObject([{ content: 'same text', baseVersion: 'newer-base' }])
  })

  it('first save posts once without a fileId and persists the returned entry', async () => {
    const { result } = await start()
    write.mockResolvedValue(json(meta()))
    await act(async () => {
      expect(await result.current.save(date, 'hello', null)).toEqual(entry())
    })
    expect(write).toHaveBeenCalledExactlyOnceWith(date, { content: 'hello', baseVersion: null, force: false })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await getAllCached()).toEqual([expect.objectContaining({ owner: email, date, meta: meta(), content: entry().entry })])
  })

  it.each([
    ['1', '2', undefined],
    ['5', '6', undefined],
    ['2', '4', 'draft'],
  ])('saves over cached version %s as version %s with one POST', async (baseVersion, nextVersion, baseContent) => {
    const { result } = await start()
    write.mockResolvedValueOnce(json(meta(date, baseVersion)))
    await act(async () => { await result.current.save(date, 'draft', null) })
    fetchMock.mockClear()
    write.mockClear()
    write.mockResolvedValueOnce(json(meta(date, nextVersion)))
    await act(async () => {
      expect((await result.current.save(date, 'draft with more', baseVersion, false, baseContent)).meta.version).toBe(nextVersion)
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledExactlyOnceWith(date, {
      content: 'draft with more', fileId: meta().id, baseVersion, force: false,
      ...(baseContent === undefined ? {} : { baseContent }),
    })
  })

  it.each(['listed', 'saved'])('surfaces remote conflicts with a %s cached entry and preserves the draft', async cachedBy => {
    const { result } = await start(cachedBy === 'listed' ? [meta()] : [])
    if (cachedBy === 'saved') {
      write.mockResolvedValueOnce(json(meta()))
      await act(async () => { await result.current.save(date, 'original', null) })
    }
    write.mockClear()
    fetchMock.mockClear()
    const remote = entry(date, '2', 'remote changed text')
    write.mockResolvedValueOnce(json({ conflict: remote }, 409))
    await act(async () => {
      await expect(result.current.save(date, 'my local edits', '1')).rejects.toMatchObject({
        name: EntryConflictError.name, remote,
      })
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await getAllDrafts(email))[0]).toMatchObject({ date, content: 'my local edits' })
  })

  it('bypasses cached content for forceNetwork and caches the refreshed entry', async () => {
    const { result } = await start([meta()])
    read.mockResolvedValueOnce(json(entry()))
    await act(async () => { await result.current.getContent(date) })
    fetchMock.mockClear()
    read.mockResolvedValueOnce(json(entry(date, '2', 'fresh text')))
    await act(async () => {
      expect(await result.current.getContent(date, { forceNetwork: true })).toEqual(entry(date, '2', 'fresh text'))
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/drive/entry/${date}?fileId=${meta().id}`)
    fetchMock.mockClear()
    await act(async () => {
      expect((await result.current.getContent(date))?.entry.content).toBe('fresh text')
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await getAllCached())[0].content?.content).toBe('fresh text')
  })

  it.each(['older', 'missing'] as const)('keeps a completed save when an earlier read returns %s content', async response => {
    const { result } = await start()
    write.mockResolvedValueOnce(json(meta()))
    await act(async () => { await result.current.save(date, 'original text', null) })
    const delayed = deferred<Response>()
    read.mockReturnValueOnce(delayed.promise)
    let reading!: ReturnType<typeof result.current.getContent>
    act(() => { reading = result.current.getContent(date, { forceNetwork: true }) })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())

    write.mockResolvedValueOnce(json(meta(date, '2')))
    await act(async () => { await result.current.save(date, 'newly saved text', '1') })
    await act(async () => {
      delayed.resolve(response === 'older' ? json(entry(date, '1', 'original text')) : json(null, 404))
      expect(await reading).toEqual(entry(date, '2', 'newly saved text'))
    })
    expect(await result.current.getContent(date)).toEqual(entry(date, '2', 'newly saved text'))
    expect(await getAllCached()).toEqual([expect.objectContaining({
      meta: meta(date, '2'), content: entry(date, '2', 'newly saved text').entry,
    })])
  })

  it('does not recreate a deleted entry when an older read finishes', async () => {
    const { result } = await start()
    write.mockResolvedValueOnce(json(meta()))
    await act(async () => { await result.current.save(date, 'original text', null) })
    const delayed = deferred<Response>()
    read.mockReturnValueOnce(delayed.promise)
    let reading!: ReturnType<typeof result.current.getContent>
    act(() => { reading = result.current.getContent(date, { forceNetwork: true }) })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await act(async () => { await result.current.remove(date) })
    await act(async () => {
      delayed.resolve(json(entry()))
      expect(await reading).toBeNull()
    })
    expect(result.current.dates).not.toContain(date)
    expect(await getAllCached()).toEqual([])
  })

  it('notifies onExpired and rethrows TokenExpiredError on a read returning 401', async () => {
    const { result, onExpired } = await start()
    read.mockResolvedValueOnce(json({}, 401))
    await act(async () => { await expect(result.current.getContent(date)).rejects.toBeInstanceOf(TokenExpiredError) })
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('preserves baseContent when retrying a pending save after session expiry', async () => {
    const { result, onExpired } = await start([meta()])
    write.mockResolvedValueOnce(json({}, 401))
    await act(async () => {
      await expect(result.current.save(date, 'pending content', '1', false, 'saved base')).rejects.toBeInstanceOf(TokenExpiredError)
    })
    expect(onExpired).toHaveBeenCalledOnce()
    write.mockResolvedValueOnce(json(meta(date, '2')))
    await act(async () => {
      expect((await result.current.retryPendingSave())?.meta.version).toBe('2')
    })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]).toEqual([date, {
      content: 'pending content', fileId: meta().id, baseVersion: '1', baseContent: 'saved base', force: false,
    }])
    expect(await getAllDrafts(email)).toEqual([])
  })

  it.each(['search', 'export', 'import'] as const)('%s bounds concurrent requests and completes the whole batch', async operation => {
    const days = Array.from({ length: 7 }, (_, i) => `2026-05-0${i + 1}`)
    const { result } = await start(operation === 'export' ? days.map(day => meta(day)) : [])
    files = days.map(day => meta(day))
    const limit = operation === 'search' ? 5 : 4
    const gates = days.map(() => deferred<Response>())
    let active = 0
    let peak = 0
    let started = 0
    const respond = async () => {
      const gate = gates.at(started++)!
      peak = Math.max(peak, ++active)
      try { return await gate.promise } finally { active-- }
    }
    read.mockImplementation(respond)
    write.mockImplementation(respond)
    const progress = vi.fn()
    const entries = days.map(day => ({ date: day, content: `needle ${day}` }))
    let task!: Promise<unknown>
    act(() => {
      task = operation === 'search' ? result.current.search('needle')
        : operation === 'export' ? result.current.exportAll(progress)
          : result.current.importAll(entries, progress)
    })
    await waitFor(() => expect(started).toBe(limit))
    expect(active).toBe(limit)
    // Complete requests in reverse order; output order must remain stable.
    for (let i = 0; i < days.length; i++) {
      const index = i < limit ? limit - 1 - i : i
      await waitFor(() => expect(started).toBeGreaterThan(index))
      await act(async () => {
        const day = operation === 'import' ? write.mock.calls.at(index)![0] : read.mock.calls.at(index)![0]
        gates.at(index)!.resolve(json(operation === 'import' ? meta(day) : entry(day, '1', `needle ${day}`)))
      })
      if (i === 0) await waitFor(() => expect(started).toBe(limit + 1))
    }
    let output: unknown
    await act(async () => { output = await task })
    expect(peak).toBe(limit)
    expect(active).toBe(0)
    expect(started).toBe(days.length)
    if (operation === 'search') {
      expect(output).toEqual({
        results: [...days].reverse().map(day => ({ date: day, snippet: `needle ${day}` })),
        unindexedCount: 0, totalCount: days.length,
      })
    } else {
      expect(progress.mock.calls).toEqual(days.map((_, i) => [i + 1, days.length]))
      if (operation === 'export') expect(output).toEqual(entries)
      else expect(output).toEqual({ imported: expect.arrayContaining(days), skipped: [], failed: [] })
    }
  })

  it('exports bare body text without adding frontmatter', async () => {
    const { result } = await start([meta()])
    read.mockResolvedValueOnce(json(entry(date, '1', 'hello world')))
    await act(async () => {
      expect(await result.current.exportAll()).toEqual([{ date, content: 'hello world' }])
    })
  })

  it('imports only missing dates without sending writes for existing dates', async () => {
    const { result } = await start([meta(), meta('2026-05-02')])
    write.mockResolvedValueOnce(json(meta('2026-05-03')))
    await act(async () => {
      expect(await result.current.importAll([date, '2026-05-02', '2026-05-03'].map(day => ({ date: day, content: day })))).toEqual({
        imported: ['2026-05-03'], skipped: [date, '2026-05-02'], failed: [],
      })
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toBe('2026-05-03')
  })

  it('treats an import conflict as skipped', async () => {
    const { result } = await start()
    write.mockResolvedValueOnce(json({ conflict: null }, 409))
    await act(async () => {
      expect(await result.current.importAll([{ date, content: 'raced entry' }])).toEqual({ imported: [], skipped: [date], failed: [] })
    })
  })

  it('collects per-entry import failures while importing the rest', async () => {
    const { result } = await start()
    write.mockImplementation(async day => day === date ? json(meta()) : json('bad request', 400))
    await act(async () => {
      expect(await result.current.importAll([date, '2026-05-02'].map(day => ({ date: day, content: 'text' })))).toEqual({
        imported: [date], skipped: [], failed: ['2026-05-02'],
      })
    })
  })

  it('propagates token expiry during import and notifies the app', async () => {
    const { result, onExpired } = await start()
    write.mockResolvedValueOnce(json({}, 401))
    await act(async () => {
      await expect(result.current.importAll([{ date, content: 'entry' }])).rejects.toBeInstanceOf(TokenExpiredError)
    })
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('merges new Changes API entries into memory and IDB without remounting', async () => {
    const { result } = await start([meta()])
    changes = ['2026-05-03', '2026-05-02'].map(day => ({ fileId: meta(day).id, removed: false, file: meta(day) }))
    await act(async () => { await result.current.refreshEntries() })
    expect(result.current.dates).toEqual(['2026-05-03', '2026-05-02', date])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/drive/changes')
    expect((await getAllCached()).map(cached => cached.date).sort()).toEqual([date, '2026-05-02', '2026-05-03'])
  })

  it('preserves entries when the Changes API returns no changes', async () => {
    const { result } = await start([meta()])
    await act(async () => { await result.current.refreshEntries() })
    expect(result.current.dates).toEqual([date])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/drive/changes')
  })

  it.each(['same', 'updated', 'removed'] as const)('reconciles %s cached content and reports evictions', async kind => {
    const { result, onEvicted } = await start([meta(), meta('2026-05-02')])
    read.mockResolvedValueOnce(json(entry()))
    await act(async () => { await result.current.getContent(date) })
    changes = [{
      fileId: meta().id, removed: kind === 'removed',
      ...(kind === 'removed' ? {} : { file: meta(date, kind === 'updated' ? '2' : '1') }),
    }]
    await act(async () => { await result.current.refreshEntries() })
    if (kind === 'same') expect(onEvicted).not.toHaveBeenCalled()
    else expect(onEvicted).toHaveBeenCalledExactlyOnceWith([date])
    if (kind === 'removed') {
      expect(result.current.dates).toEqual(['2026-05-02'])
      expect((await getAllCached()).map(cached => cached.date)).toEqual(['2026-05-02'])
    } else {
      read.mockClear()
      read.mockResolvedValueOnce(json(entry(date, '2', 'updated')))
      await act(async () => {
        expect((await result.current.getContent(date))?.entry.content).toBe(kind === 'updated' ? 'updated' : 'hello')
      })
      expect(read).toHaveBeenCalledTimes(kind === 'updated' ? 1 : 0)
    }
  })
})
