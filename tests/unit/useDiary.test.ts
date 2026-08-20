import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiary } from '../../src/hooks/useDiary'
import * as driveEntries from '../../src/api/driveEntries'
import * as diaryCache from '../../src/lib/diaryCache'
import type { DiaryEntry, DriveFileMeta, LoadedDiaryEntry } from '../../src/types'

vi.mock('../../src/api/driveEntries', () => ({
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryByDate: vi.fn().mockResolvedValue(null),
  saveEntry: vi.fn(),
  deleteEntry: vi.fn(),
  searchEntries: vi.fn().mockResolvedValue([]),
  getChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: '' }),
  TokenExpiredError: class TokenExpiredError extends Error { name = 'TokenExpiredError' as const },
  SaveConflictError: class SaveConflictError extends Error { name = 'SaveConflictError' as const; remote: LoadedDiaryEntry | null; constructor(r: LoadedDiaryEntry | null) { super('conflict'); this.remote = r } },
  DriveHttpError: class DriveHttpError extends Error { status: number; constructor(s: number, b: string) { super(b); this.status = s } },
}))

vi.mock('../../src/lib/diaryCache', () => ({
  getAllCached: vi.fn().mockResolvedValue([]),
  putCached: vi.fn().mockResolvedValue(undefined),
  deleteCached: vi.fn().mockResolvedValue(undefined),
  clearCache: vi.fn().mockResolvedValue(undefined),
  getAllDrafts: vi.fn().mockResolvedValue([]),
  getDraft: vi.fn().mockResolvedValue(undefined),
  putDraft: vi.fn().mockResolvedValue(undefined),
  deleteDraft: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/utils/tabSync', () => ({
  broadcastMessage: vi.fn(),
}))

const meta = (date: string, version = '1', id = `file-${date}`): DriveFileMeta => ({
  id,
  name: `diary-${date}.txt`,
  version,
})

const entryObj = (date: string, content?: string): DiaryEntry => ({ date, content: content ?? `Entry for ${date}` })

beforeEach(() => {
  vi.clearAllMocks()
})

function renderUseDiary(opts: { email?: string | null; authStatus?: 'initializing' | 'signedOut' | 'signedIn' } = {}) {
  const onExpired = vi.fn()
  const onEntriesEvicted = vi.fn()
  return {
    ...renderHook(({ authStatus, email }) => useDiary(authStatus, email, onExpired, onEntriesEvicted), {
      initialProps: {
        authStatus: opts.authStatus ?? 'signedIn' as const,
        email: opts.email ?? 'user@example.com',
      },
    }),
    onExpired,
    onEntriesEvicted,
  }
}

describe('useDiary initial load parallelization', () => {
  it('calls listEntries and getEntryByDate(today) in parallel', async () => {
    const todayMeta = meta('2026-08-20')
    const todayContent = entryObj('2026-08-20', 'Today diary')

    let listResolves: (files: DriveFileMeta[]) => void
    let contentResolves: (result: LoadedDiaryEntry | null) => void

    vi.mocked(driveEntries.listEntries).mockImplementationOnce(() =>
      new Promise(r => { listResolves = r }),
    )
    vi.mocked(driveEntries.getEntryByDate).mockImplementationOnce(() =>
      new Promise(r => { contentResolves = r }),
    )

    const { result } = renderUseDiary()

    await waitFor(() => expect(result.current.loading).toBe(true))

    // Both should have been called before either resolves
    expect(driveEntries.listEntries).toHaveBeenCalledOnce()
    expect(driveEntries.getEntryByDate).toHaveBeenCalledWith('2026-08-20')

    // Resolve both
    await act(async () => {
      contentResolves!({ entry: todayContent, meta: todayMeta })
      listResolves!([todayMeta])
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.dates).toContain('2026-08-20')
  })

  it('merges pre-fetched content into cache after listEntries reconciles', async () => {
    const todayMeta = meta('2026-08-20')
    const todayContent = entryObj('2026-08-20', 'Pre-fetched today')
    const yesterdayMeta = meta('2026-08-19')

    vi.mocked(driveEntries.listEntries).mockResolvedValueOnce([todayMeta, yesterdayMeta])
    vi.mocked(driveEntries.getEntryByDate).mockResolvedValueOnce({ entry: todayContent, meta: todayMeta })

    const { result } = renderUseDiary()

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.dates).toContain('2026-08-20')
    expect(result.current.dates).toContain('2026-08-19')

    // getEntryByDate was called for today (parallel pre-fetch)
    expect(driveEntries.getEntryByDate).toHaveBeenCalledWith('2026-08-20')
  })

  it('does not re-fetch today via background prefetch (already pre-fetched)', async () => {
    const files: DriveFileMeta[] = [
      meta('2026-08-20'),
      meta('2026-08-19'),
      meta('2026-08-18'),
      meta('2026-08-17'),
    ]

    vi.mocked(driveEntries.listEntries).mockResolvedValueOnce(files)
    // Pre-fetch for today
    vi.mocked(driveEntries.getEntryByDate).mockResolvedValueOnce({
      entry: entryObj('2026-08-20'),
      meta: meta('2026-08-20'),
    })

    const { result } = renderUseDiary()

    await waitFor(() => expect(result.current.loading).toBe(false))

    // Today is excluded from background prefetch, so only the parallel
    // pre-fetch should have called getEntryByDate for today.
    // The background queue fetches 19 and 18 (concurrency=2).
    await waitFor(() => {
      expect(driveEntries.getEntryByDate).toHaveBeenCalled()
    })

    // Today should only appear once in getEntryByDate calls
    const todayCalls = vi.mocked(driveEntries.getEntryByDate).mock.calls
      .filter(([date]) => date === '2026-08-20')
    expect(todayCalls).toHaveLength(1)

    // Background prefetches for 19 and 18 should also have run
    await new Promise(r => setTimeout(r, 500))
    const allCalls = vi.mocked(driveEntries.getEntryByDate).mock.calls
    const dates = allCalls.map(([d]) => d)
    expect(dates).toContain('2026-08-19')
    expect(dates).toContain('2026-08-18')
  })

  it('hydrates from IDB first, then syncs with Drive', async () => {
    const idbEntry = { date: '2026-08-19', meta: meta('2026-08-19'), content: entryObj('2026-08-19', 'From IDB') }

    let idbResolves: (entries: typeof idbEntry[]) => void

    vi.mocked(diaryCache.getAllCached).mockImplementationOnce(() =>
      new Promise(r => { idbResolves = r }),
    )
    vi.mocked(driveEntries.listEntries).mockResolvedValueOnce([meta('2026-08-19'), meta('2026-08-20')])
    vi.mocked(driveEntries.getEntryByDate).mockResolvedValue(null)

    const { result } = renderUseDiary()

    // Before IDB resolves, loading should be true
    expect(result.current.loading).toBe(true)

    // Resolve IDB — loading should become false (IDB hydrated)
    await act(async () => {
      idbResolves!([idbEntry])
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.dates).toContain('2026-08-19')

    // Drive sync then adds more entries
    await waitFor(() => expect(result.current.dates).toContain('2026-08-20'))
  })
})
