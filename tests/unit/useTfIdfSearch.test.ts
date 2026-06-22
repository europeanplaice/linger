import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedEntry } from '../../src/lib/diaryCache'

const { mockGetAllCached } = vi.hoisted(() => ({
  mockGetAllCached: vi.fn<() => Promise<CachedEntry[]>>(),
}))

vi.mock('../../src/lib/diaryCache', () => ({
  getAllCached: mockGetAllCached,
}))

import { useTfIdfSearch } from '../../src/hooks/useTfIdfSearch'

function makeEntry(date: string, content: string): CachedEntry {
  return {
    date,
    meta: { id: `id-${date}`, name: `diary-${date}.txt` },
    content: { date, content },
  }
}

beforeEach(() => {
  mockGetAllCached.mockReset()
})

describe('useTfIdfSearch', () => {
  it('starts with ready=false and becomes true after cache loads', async () => {
    mockGetAllCached.mockResolvedValueOnce([makeEntry('2024-01-01', 'hello world')])
    const { result } = renderHook(() => useTfIdfSearch())
    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('searchLocal returns empty array before ready', () => {
    let resolve!: (v: CachedEntry[]) => void
    mockGetAllCached.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { result } = renderHook(() => useTfIdfSearch())
    expect(result.current.searchLocal('hello')).toEqual([])
    act(() => resolve([]))
  })

  it('searchLocal finds matching entries after index is built', async () => {
    mockGetAllCached.mockResolvedValueOnce([
      makeEntry('2024-01-01', '今日は疲れた'),
      makeEntry('2024-01-02', '楽しい一日だった'),
    ])
    const { result } = renderHook(() => useTfIdfSearch())
    await waitFor(() => expect(result.current.ready).toBe(true))

    const hits = result.current.searchLocal('疲れ')
    expect(hits.length).toBe(1)
    expect(hits[0].date).toBe('2024-01-01')
    expect(hits[0].snippet).toBeTruthy()
  })

  it('getSimilar returns similar entries without including the source date', async () => {
    mockGetAllCached.mockResolvedValueOnce([
      makeEntry('2024-01-01', '仕事が大変で疲れた。残業が続く。'),
      makeEntry('2024-01-02', '疲れが取れない。仕事を休みたい。'),
      makeEntry('2024-01-03', '楽しい休日。映画を見た。'),
    ])
    const { result } = renderHook(() => useTfIdfSearch())
    await waitFor(() => expect(result.current.ready).toBe(true))

    const similar = result.current.getSimilar('2024-01-01', 2)
    expect(similar).not.toContain('2024-01-01')
    expect(similar.length).toBeGreaterThan(0)
    expect(similar).toContain('2024-01-02')
  })

  it('updateEntry rebuilds the index so new content is searchable', async () => {
    // Use two entries: after update, the updated entry must rank first for the new keyword
    mockGetAllCached.mockResolvedValue([
      makeEntry('2024-01-01', 'weather was nice today'),
      makeEntry('2024-01-02', 'went shopping downtown'),
    ])
    const { result } = renderHook(() => useTfIdfSearch())
    await waitFor(() => expect(result.current.ready).toBe(true))

    // Neither entry mentions "volcano"
    const before = result.current.searchLocal('volcano')
    expect(before.find(h => h.date === '2024-01-01')).toBeUndefined()

    await act(async () => {
      result.current.updateEntry('2024-01-01', 'volcano volcano volcano eruption lava')
      await new Promise(r => setTimeout(r, 10))
    })

    const hits = result.current.searchLocal('volcano')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].date).toBe('2024-01-01')
  })

  it('ignores entries without loaded content', async () => {
    mockGetAllCached.mockResolvedValueOnce([
      { date: '2024-01-01', meta: { id: 'id1', name: 'diary-2024-01-01.txt' } },
      makeEntry('2024-01-02', 'hello world today'),
    ])
    const { result } = renderHook(() => useTfIdfSearch())
    await waitFor(() => expect(result.current.ready).toBe(true))

    const hits = result.current.searchLocal('hello')
    expect(hits.length).toBe(1)
    expect(hits[0].date).toBe('2024-01-02')
  })

  it('indexVersion increments when updateEntry is called', async () => {
    mockGetAllCached.mockResolvedValue([
      makeEntry('2024-01-01', 'hello world'),
    ])
    const { result } = renderHook(() => useTfIdfSearch())
    await waitFor(() => expect(result.current.ready).toBe(true))
    const versionAfterInit = result.current.indexVersion

    await act(async () => {
      result.current.updateEntry('2024-01-01', 'updated content')
      await new Promise(r => setTimeout(r, 10))
    })

    expect(result.current.indexVersion).toBeGreaterThan(versionAfterInit)
  })

  it('handles IndexedDB error gracefully — ready stays false, methods return empty', async () => {
    mockGetAllCached.mockRejectedValueOnce(new Error('IDB unavailable'))
    const { result } = renderHook(() => useTfIdfSearch())
    await new Promise(r => setTimeout(r, 20))
    expect(result.current.ready).toBe(false)
    expect(result.current.searchLocal('anything')).toEqual([])
    expect(result.current.getSimilar('2024-01-01')).toEqual([])
  })

  it('getSimilar returns empty before index is ready', () => {
    let resolve!: (v: CachedEntry[]) => void
    mockGetAllCached.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { result } = renderHook(() => useTfIdfSearch())
    expect(result.current.getSimilar('2024-01-01')).toEqual([])
    act(() => resolve([]))
  })
})
