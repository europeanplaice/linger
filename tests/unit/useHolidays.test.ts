import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HolidayMap } from '../../src/utils/holidays'

// Use year values far in the future so tests never collide with the
// module-level cache populated by other tests in this file.
let nextYear = 3000

function freshYear() {
  return nextYear++
}

const { mockFetchHolidays } = vi.hoisted(() => ({
  mockFetchHolidays: vi.fn<(country: string, year: number) => Promise<HolidayMap>>(),
}))

vi.mock('../../src/api/holidays', () => ({
  fetchHolidays: mockFetchHolidays,
}))

import { useHolidays } from '../../src/hooks/useHolidays'

beforeEach(() => {
  mockFetchHolidays.mockReset()
})

describe('useHolidays', () => {
  it('returns an empty map immediately when country is "off" and never fetches', async () => {
    const { result } = renderHook(() => useHolidays('off', freshYear()))
    expect(result.current).toEqual({})
    expect(mockFetchHolidays).not.toHaveBeenCalled()
  })

  it('switches to empty and stops fetching when country changes to "off"', async () => {
    const year = freshYear()
    let resolveFetch!: (m: HolidayMap) => void
    mockFetchHolidays.mockImplementation(() => new Promise<HolidayMap>(r => { resolveFetch = r }))

    const { result, rerender } = renderHook(
      ({ country }: { country: string }) => useHolidays(country as 'JP' | 'off', year),
      { initialProps: { country: 'JP' } },
    )

    rerender({ country: 'off' })
    expect(result.current).toEqual({})

    // Resolve the stale fetch — the active flag should suppress the state update
    act(() => resolveFetch({ '2000-01-01': 'Holiday' }))
    await new Promise(r => setTimeout(r, 0))
    expect(result.current).toEqual({})
  })

  it('fetches holidays and exposes the map', async () => {
    const year = freshYear()
    const holidays: HolidayMap = { '3100-01-01': 'Future Day' }
    mockFetchHolidays.mockResolvedValueOnce(holidays)

    const { result } = renderHook(() => useHolidays('JP', year))

    await waitFor(() => expect(result.current).toEqual(holidays))
    expect(mockFetchHolidays).toHaveBeenCalledWith('JP', year)
  })

  it('deduplicates in-flight requests: two hooks with the same key share one fetch', async () => {
    const year = freshYear()
    const holidays: HolidayMap = { '3200-01-01': 'Day' }
    let resolveFetch!: (m: HolidayMap) => void
    mockFetchHolidays.mockImplementation(() => new Promise<HolidayMap>(r => { resolveFetch = r }))

    const { result: r1 } = renderHook(() => useHolidays('GB', year))
    const { result: r2 } = renderHook(() => useHolidays('GB', year))

    // Both hooks are loading the same key — only one fetch should have started
    expect(mockFetchHolidays).toHaveBeenCalledTimes(1)

    act(() => resolveFetch(holidays))

    await waitFor(() => expect(r1.current).toEqual(holidays))
    await waitFor(() => expect(r2.current).toEqual(holidays))

    // Still just the one call
    expect(mockFetchHolidays).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed fetch so the next call retries', async () => {
    const year = freshYear()
    const holidays: HolidayMap = { '3300-01-01': 'Retry Day' }

    // First call fails
    mockFetchHolidays.mockRejectedValueOnce(new Error('network'))
    // Second call succeeds
    mockFetchHolidays.mockResolvedValueOnce(holidays)

    const { result: r1, unmount } = renderHook(() => useHolidays('US', year))
    await waitFor(() => expect(mockFetchHolidays).toHaveBeenCalledTimes(1))
    // Failed fetch → hook returns empty (graceful)
    await new Promise(r => setTimeout(r, 0))
    expect(r1.current).toEqual({})
    unmount()

    // New hook for same key — should fetch again since previous failed
    const { result: r2 } = renderHook(() => useHolidays('US', year))
    await waitFor(() => expect(r2.current).toEqual(holidays))
    expect(mockFetchHolidays).toHaveBeenCalledTimes(2)
  })

  it('serves a cached result synchronously on mount without refetching', async () => {
    const year = freshYear()
    const holidays: HolidayMap = { '3500-01-01': 'Cached Day' }

    // First hook populates the module-level cache
    mockFetchHolidays.mockResolvedValueOnce(holidays)
    const { unmount: u1 } = renderHook(() => useHolidays('DE', year))
    await waitFor(() => expect(mockFetchHolidays).toHaveBeenCalledTimes(1))
    u1()

    // Second hook with same key — must read from cache, no new fetch
    const { result } = renderHook(() => useHolidays('DE', year))
    expect(result.current).toEqual(holidays)
    expect(mockFetchHolidays).toHaveBeenCalledTimes(1)
  })

  it('does not update state after unmount (active flag guard)', async () => {
    const year = freshYear()
    let resolveFetch!: (m: HolidayMap) => void
    mockFetchHolidays.mockImplementation(() => new Promise<HolidayMap>(r => { resolveFetch = r }))

    const { result, unmount } = renderHook(() => useHolidays('FR', year))
    unmount()

    // Resolving after unmount must not cause a React state-update-after-unmount error
    await expect(
      new Promise<void>((resolve, reject) => {
        const origError = console.error.bind(console)
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
          if (String(args[0]).includes('unmounted')) reject(new Error('state update after unmount'))
          else origError(...args)
        })
        act(() => resolveFetch({ '3400-01-01': 'Late Day' }))
        setTimeout(() => {
          vi.mocked(console.error).mockRestore()
          resolve()
        }, 20)
      }),
    ).resolves.toBeUndefined()

    expect(result.current).toEqual({})
  })
})
