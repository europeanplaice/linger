import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_SAVE_MAX_WAIT_MS,
  AUTO_SAVE_MS,
  AUTO_SAVE_RETRY_BASE_MS,
  AUTO_SAVE_RETRY_MAX_MS,
  useAutoSave,
} from '../../src/hooks/useAutoSave'

describe('useAutoSave', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('retries without further typing after a failure or an overlapping save', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    let allowed = false
    const { unmount } = renderHook(() => useAutoSave({ enabled: true, isDirty: true, text: 'draft', save, canSave: () => allowed }))
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).not.toHaveBeenCalled()
    allowed = true
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_RETRY_BASE_MS) })
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_RETRY_BASE_MS) })
    expect(save).toHaveBeenCalledTimes(2)
    allowed = false
    unmount()
  })

  it('backs off exponentially on consecutive failures up to the cap and resets on new input', async () => {
    const save = vi.fn(async () => false)
    const canSave = () => true
    const { rerender, unmount } = renderHook(
      ({ text }) => useAutoSave({ enabled: true, isDirty: true, text, save, canSave }),
      { initialProps: { text: 'draft' } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).toHaveBeenCalledTimes(1)

    // Consecutive backoff delays: 5s, 10s, 20s, 40s, 60s (capped)
    for (const delay of [5000, 10000, 20000, 40000, AUTO_SAVE_RETRY_MAX_MS, AUTO_SAVE_RETRY_MAX_MS]) {
      const before = save.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
      expect(save).toHaveBeenCalledTimes(before)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(save).toHaveBeenCalledTimes(before + 1)
    }

    // New input resets backoff back to the normal idle debounce.
    const countBeforeEdit = save.mock.calls.length
    rerender({ text: 'draft updated' })
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).toHaveBeenCalledTimes(countBeforeEdit + 1)
    unmount()
  })

  it('saves the latest text after the max-wait window of uninterrupted typing without saving on every subsequent keystroke', () => {
    const save = vi.fn(async () => true)
    const canSave = () => true
    const { rerender, unmount } = renderHook(({ text }) => useAutoSave({ enabled: true, isDirty: true, text, save, canSave }), { initialProps: { text: '' } })
    const seconds = AUTO_SAVE_MAX_WAIT_MS / 1000
    for (let second = 1; second <= seconds; second++) {
      act(() => { vi.advanceTimersByTime(1000) })
      rerender({ text: `edit ${second}` })
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(false)
    act(() => { vi.advanceTimersByTime(1000) })
    rerender({ text: `edit ${seconds + 1}` })
    expect(save).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('schedules a prompt follow-up save when savedText updates after an in-flight save with newer edits', async () => {
    const save = vi.fn(async () => true)
    let allowed = false
    const { rerender, unmount } = renderHook(
      ({ text, savedText }) => useAutoSave({ enabled: true, isDirty: text !== savedText, text, savedText, save, canSave: () => allowed }),
      { initialProps: { text: 'first+second', savedText: '' } },
    )
    // First debounce hits while an earlier save is still in flight -> enters 5s wait.
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).not.toHaveBeenCalled()

    // Earlier save finishes and updates savedText; follow-up edits should save
    // after AUTO_SAVE_MS rather than waiting for the full 5s retry timer.
    allowed = true
    rerender({ text: 'first+second', savedText: 'first' })
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).toHaveBeenCalledTimes(1)
    allowed = false
    unmount()
  })

  it('pauses cloud saves and leave flushes while offline and resumes when back online', async () => {
    const save = vi.fn(async () => true)
    const canSave = () => true
    const { rerender, unmount } = renderHook(
      ({ isOnline }) => useAutoSave({ enabled: true, isDirty: true, isOnline, text: 'offline draft', save, canSave }),
      { initialProps: { isOnline: false } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(save).not.toHaveBeenCalled()

    rerender({ isOnline: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('holds auto-save while IME composition is active and saves once composition ends', async () => {
    const save = vi.fn(async () => true)
    const canSave = () => true
    const { rerender, unmount } = renderHook(
      ({ isComposing, text }) => useAutoSave({ enabled: true, isDirty: true, isComposing, text, save, canSave }),
      { initialProps: { isComposing: true, text: 'きょうは' } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MAX_WAIT_MS + 5000) })
    expect(save).not.toHaveBeenCalled()

    rerender({ isComposing: false, text: '今日は' })
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS) })
    expect(save).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('flushes with keepalive on hide/pagehide only when saving is allowed, and cleans up listeners', () => {
    const save = vi.fn(async () => true)
    let allowed = true
    const { result, unmount } = renderHook(() => useAutoSave({ enabled: true, isDirty: true, text: 'draft', save, canSave: () => allowed }))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith(false, { keepalive: true })

    act(() => { result.current() })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(false, undefined)

    allowed = false
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    unmount()
    act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')) })
    expect(save).toHaveBeenCalledTimes(2)
    visibility.mockRestore()
  })
})
