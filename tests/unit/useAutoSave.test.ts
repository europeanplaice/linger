import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave } from '../../src/hooks/useAutoSave'

describe('useAutoSave', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('saves the latest text after ten seconds of uninterrupted typing without saving on every subsequent keystroke', () => {
    const save = vi.fn(async () => true)
    const canSave = () => true
    const { rerender, unmount } = renderHook(({ text }) => useAutoSave({ enabled: true, isDirty: true, text, save, canSave }), { initialProps: { text: '' } })
    for (let second = 1; second <= 10; second++) {
      act(() => { vi.advanceTimersByTime(1000) })
      rerender({ text: `edit ${second}` })
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(false)
    act(() => { vi.advanceTimersByTime(1000) })
    rerender({ text: 'edit 11' })
    expect(save).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('flushes on hide and pagehide only when saving is allowed, and cleans up listeners', () => {
    const save = vi.fn(async () => true)
    let allowed = true
    const { unmount } = renderHook(() => useAutoSave({ enabled: true, isDirty: true, text: 'draft', save, canSave: () => allowed }))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(save).toHaveBeenCalledTimes(1)
    allowed = false
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    unmount()
    act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')) })
    expect(save).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })
})
