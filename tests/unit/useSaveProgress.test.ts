import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSaveProgress } from '../../src/hooks/useSaveProgress'

const STORAGE_KEY = 'gp-save-timings'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useSaveProgress', () => {
  it('starts with progress null', () => {
    const { result } = renderHook(() => useSaveProgress())
    expect(result.current.progress).toBeNull()
  })

  it('startSave sets progress to 0', () => {
    const { result } = renderHook(() => useSaveProgress())
    act(() => result.current.startSave())
    expect(result.current.progress).toBe(0)
  })

  it('completeSave(true) sets progress to 1 then null after 600ms', async () => {
    const { result } = renderHook(() => useSaveProgress())

    act(() => result.current.startSave())
    act(() => result.current.completeSave(true))

    expect(result.current.progress).toBe(1)

    act(() => vi.advanceTimersByTime(600))
    expect(result.current.progress).toBeNull()
  })

  it('completeSave(false) also transitions to 1 then null', async () => {
    const { result } = renderHook(() => useSaveProgress())

    act(() => result.current.startSave())
    act(() => result.current.completeSave(false))

    expect(result.current.progress).toBe(1)

    act(() => vi.advanceTimersByTime(600))
    expect(result.current.progress).toBeNull()
  })

  it('completeSave(true) records elapsed time in localStorage', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const { result } = renderHook(() => useSaveProgress())

    now = 1000
    act(() => result.current.startSave())

    now = 4500
    act(() => result.current.completeSave(true))

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored).toEqual([3500])
  })

  it('completeSave(false) does not record timing', () => {
    const { result } = renderHook(() => useSaveProgress())

    act(() => result.current.startSave())
    act(() => result.current.completeSave(false))

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored).toEqual([])
  })

  it('uses stored average as estimate for next save', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([2000, 4000, 6000]))

    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const { result } = renderHook(() => useSaveProgress())

    now = 0
    act(() => result.current.startSave())

    now = 5000
    act(() => result.current.completeSave(true))

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored).toEqual([2000, 4000, 6000, 5000])
  })

  it('caps stored samples at 10', () => {
    const existing = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))

    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const { result } = renderHook(() => useSaveProgress())

    now = 0
    act(() => result.current.startSave())
    now = 3000
    act(() => result.current.completeSave(true))

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    expect(stored).toHaveLength(10)
    expect(stored[stored.length - 1]).toBe(3000)
    expect(stored[0]).toBe(existing[1])
  })

  it('second startSave before completeSave resets progress to 0', () => {
    const { result } = renderHook(() => useSaveProgress())

    act(() => result.current.startSave())
    act(() => result.current.completeSave(true))
    act(() => result.current.startSave())

    expect(result.current.progress).toBe(0)
  })

  it('progress stays null before any save', async () => {
    const { result } = renderHook(() => useSaveProgress())
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.progress).toBeNull()
  })

  it('advances toward 90% using animation frames and the current estimate', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.mocked(requestAnimationFrame)
    const { result } = renderHook(() => useSaveProgress())

    act(() => result.current.startSave())
    expect(result.current.progress).toBe(0)

    act(() => {
      raf.mock.calls[0][0](2000)
    })
    expect(result.current.progress).toBeCloseTo(0.45)

    act(() => {
      raf.mock.calls.at(-1)![0](5000)
    })
    expect(result.current.progress).toBe(0.9)
  })
})
