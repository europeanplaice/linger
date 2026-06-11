import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DiaryEntry, DriveRevisionMeta } from '../../src/types'
import { TokenExpiredError } from '../../src/api/driveEntries'

const { mockListRevisions, mockGetRevisionContent } = vi.hoisted(() => ({
  mockListRevisions: vi.fn<(fileId: string) => Promise<DriveRevisionMeta[]>>(),
  mockGetRevisionContent: vi.fn<(fileId: string, revisionId: string) => Promise<DiaryEntry>>(),
}))

vi.mock('../../src/api/driveRevisions', () => ({
  listRevisions: mockListRevisions,
  getRevisionContent: mockGetRevisionContent,
  TokenExpiredError,
}))

// Stub out the dynamic 'diff' import used in buildDiffHtml
vi.mock('diff', () => ({
  diffWords: () => [{ value: 'content', added: false, removed: false }],
}))

import { useRevisions } from '../../src/hooks/useRevisions'

function makeRevision(id: string, modifiedTime = '2026-05-01T10:00:00Z'): DriveRevisionMeta {
  return { id, modifiedTime }
}

function makeEntry(id: string): DiaryEntry {
  return { date: '2026-05-01', content: `content-${id}` }
}

const BASE_PARAMS = {
  fileId: 'file-1',
  date: '2026-05-01',
  baseVersion: null,
  text: 'current text',
  savedText: 'saved text',
  isDirty: false,
  autoSave: true,
  onSave: vi.fn(),
  onRestored: vi.fn(),
  onExpired: vi.fn(),
}

beforeEach(() => {
  mockListRevisions.mockReset()
  mockGetRevisionContent.mockReset()
  BASE_PARAMS.onSave.mockReset()
  BASE_PARAMS.onRestored.mockReset()
  BASE_PARAMS.onExpired.mockReset()
})

describe('useRevisions', () => {
  it('loads the revision list and auto-selects the most recent', async () => {
    mockListRevisions.mockResolvedValueOnce([
      makeRevision('rev-2'),
      makeRevision('rev-1'),
    ])
    // getRevisionContent resolves for all calls (prefetch + selection)
    mockGetRevisionContent.mockResolvedValue(makeEntry('rev-2'))

    const { result } = renderHook(() => useRevisions(BASE_PARAMS))

    expect(result.current.listLoading).toBe(true)

    await waitFor(() => expect(result.current.listLoading).toBe(false))

    expect(result.current.revisions).toHaveLength(2)
    expect(result.current.selectedId).toBe('rev-2')
    expect(mockListRevisions).toHaveBeenCalledWith('file-1')
  })

  it('calls onExpired and stops when listRevisions returns 401', async () => {
    mockListRevisions.mockRejectedValueOnce(new TokenExpiredError())

    const onExpired = vi.fn()
    const { result } = renderHook(() =>
      useRevisions({ ...BASE_PARAMS, onExpired }),
    )

    await waitFor(() => expect(result.current.listLoading).toBe(false))

    expect(onExpired).toHaveBeenCalledOnce()
    expect(result.current.listError).toBeNull()
  })

  it('sets listError when listRevisions fails with a non-auth error', async () => {
    mockListRevisions.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() => useRevisions(BASE_PARAMS))

    await waitFor(() => expect(result.current.listLoading).toBe(false))

    expect(result.current.listError).toBeTruthy()
    expect(BASE_PARAMS.onExpired).not.toHaveBeenCalled()
  })

  it('selectRevision changes selectedId and loads that revision\'s preview', async () => {
    mockListRevisions.mockResolvedValueOnce([
      makeRevision('rev-2'),
      makeRevision('rev-1'),
    ])
    // Each call returns content specific to the revision ID so the assertion
    // distinguishes which revision actually loaded.
    mockGetRevisionContent.mockImplementation((_, id) => Promise.resolve(makeEntry(id)))

    const { result } = renderHook(() => useRevisions(BASE_PARAMS))
    await waitFor(() => expect(result.current.listLoading).toBe(false))
    // Auto-selects rev-2 first — wait for its preview to avoid race
    await waitFor(() => expect(result.current.previewContent).toBe('content-rev-2'))

    act(() => result.current.selectRevision('rev-1'))

    expect(result.current.selectedId).toBe('rev-1')
    await waitFor(() => expect(result.current.previewContent).toBe('content-rev-1'))
  })

  it('does not update state after unmount during list load (cancelled guard)', async () => {
    let resolveList!: (revs: DriveRevisionMeta[]) => void
    mockListRevisions.mockImplementation(
      () => new Promise<DriveRevisionMeta[]>(r => { resolveList = r }),
    )

    const { result, unmount } = renderHook(() => useRevisions(BASE_PARAMS))
    expect(result.current.listLoading).toBe(true)

    unmount()

    // Resolving after unmount must not throw or update state
    await expect(
      new Promise<void>((resolve, reject) => {
        const origError = console.error.bind(console)
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
          if (String(args[0]).includes('unmounted')) reject(new Error('state update after unmount'))
          else origError(...args)
        })
        act(() => resolveList([makeRevision('rev-1')]))
        setTimeout(() => {
          vi.mocked(console.error).mockRestore()
          resolve()
        }, 20)
      }),
    ).resolves.toBeUndefined()
  })

  it('aborts a stale preview load when a newer revision is selected first', async () => {
    mockListRevisions.mockResolvedValueOnce([
      makeRevision('rev-2'),
      makeRevision('rev-1'),
    ])

    // Queue of resolvers per revision ID. Each call to getRevisionContent
    // produces its own pending promise so we control resolution order.
    type Resolver = (v: DiaryEntry) => void
    const resolvers: Map<string, Resolver[]> = new Map()

    mockGetRevisionContent.mockImplementation((_, id: string) => {
      return new Promise<DiaryEntry>(resolve => {
        const list = resolvers.get(id) ?? []
        list.push(resolve)
        resolvers.set(id, list)
      })
    })

    const { result } = renderHook(() => useRevisions(BASE_PARAMS))
    await waitFor(() => expect(result.current.listLoading).toBe(false))
    // Hook auto-selected rev-2 and is loading its preview + rev-1 for diff

    // Select rev-1 before rev-2's load completes → aborts rev-2's AbortController
    act(() => result.current.selectRevision('rev-1'))

    // Resolve the last rev-1 promise (the one from the rev-1 selection effect;
    // earlier calls are for the diff-prev load from rev-2's effect)
    const rev1List = resolvers.get('rev-1') ?? []
    expect(rev1List.length).toBeGreaterThanOrEqual(1)
    act(() => rev1List[rev1List.length - 1](makeEntry('rev-1')))

    await waitFor(() => expect(result.current.previewContent).toBe('content-rev-1'))

    // Resolve ALL stale rev-2 pending promises — every one must be ignored
    const rev2List = resolvers.get('rev-2') ?? []
    act(() => rev2List.forEach(resolve => resolve(makeEntry('rev-2'))))

    await new Promise(r => setTimeout(r, 20))
    expect(result.current.previewContent).toBe('content-rev-1')
  })

  it('restore() calls onSave with preview content and fires onRestored on success', async () => {
    mockListRevisions.mockResolvedValueOnce([makeRevision('rev-1')])
    mockGetRevisionContent.mockImplementation((_, id) => Promise.resolve(makeEntry(id)))

    const onSave = vi.fn<typeof BASE_PARAMS.onSave>().mockResolvedValue({
      entry: { date: '2026-05-01', content: 'content-rev-1' },
      meta: { id: 'file-1', name: 'diary-2026-05-01.txt', version: '2' },
    })
    const onRestored = vi.fn()

    const { result } = renderHook(() =>
      useRevisions({ ...BASE_PARAMS, onSave, onRestored }),
    )
    await waitFor(() => expect(result.current.previewContent).toBe('content-rev-1'))

    await act(async () => { await result.current.restore() })

    expect(onSave).toHaveBeenCalledWith(
      '2026-05-01',
      'content-rev-1',
      null,    // baseVersion
      undefined,
      'saved text', // savedText passed as baseContent
    )
    expect(onRestored).toHaveBeenCalledOnce()
    expect(result.current.restoreError).toBeNull()
  })

  it('restore() sets restoreConflict message when save throws EntryConflictError', async () => {
    mockListRevisions.mockResolvedValueOnce([makeRevision('rev-1')])
    mockGetRevisionContent.mockImplementation((_, id) => Promise.resolve(makeEntry(id)))

    const { EntryConflictError } = await import('../../src/hooks/useDiary')
    const onSave = vi.fn().mockRejectedValue(new EntryConflictError(null))

    const { result } = renderHook(() =>
      useRevisions({ ...BASE_PARAMS, onSave }),
    )
    await waitFor(() => expect(result.current.previewContent).toBe('content-rev-1'))

    await act(async () => { await result.current.restore() })

    expect(result.current.restoreError).toBeTruthy()
    expect(result.current.restoring).toBe(false)
    expect(BASE_PARAMS.onRestored).not.toHaveBeenCalled()
  })

  it('sets previewError and does not call onExpired when preview load fails with a generic error', async () => {
    mockListRevisions.mockResolvedValueOnce([makeRevision('rev-1')])
    // prefetch + selection both fail
    mockGetRevisionContent.mockRejectedValue(new Error('network'))

    const { result } = renderHook(() => useRevisions(BASE_PARAMS))
    await waitFor(() => expect(result.current.listLoading).toBe(false))

    await waitFor(() => expect(result.current.previewError).toBeTruthy())
    expect(BASE_PARAMS.onExpired).not.toHaveBeenCalled()
  })

  it('calls onExpired and clears loading when preview load returns 401', async () => {
    mockListRevisions.mockResolvedValueOnce([makeRevision('rev-1')])
    // prefetch and selection both hit 401 — the selection effect fires onExpired
    mockGetRevisionContent.mockRejectedValue(new TokenExpiredError())

    const onExpired = vi.fn()
    const { result } = renderHook(() => useRevisions({ ...BASE_PARAMS, onExpired }))
    await waitFor(() => expect(result.current.listLoading).toBe(false))

    await waitFor(() => expect(onExpired).toHaveBeenCalled())
    expect(result.current.previewError).toBeNull()
  })
})
