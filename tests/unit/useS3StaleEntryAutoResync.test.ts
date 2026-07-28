import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useS3StaleEntryAutoResync } from '../../src/hooks/useS3StaleEntryAutoResync'
import * as s3Api from '../../src/api/s3Settings'

vi.mock('../../src/api/s3Settings', () => ({
  resyncS3Backfill: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useS3StaleEntryAutoResync', () => {
  it('kicks off a resync and starts the backfill poll on the first call', async () => {
    const call = deferred<void>()
    vi.mocked(s3Api.resyncS3Backfill).mockReturnValue(call.promise)
    const startBackfill = vi.fn()

    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, false))
    act(() => { result.current() })

    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)
    expect(startBackfill).not.toHaveBeenCalled() // not until resyncS3Backfill resolves

    await act(async () => { call.resolve(); await call.promise })
    expect(startBackfill).toHaveBeenCalledTimes(1)
  })

  it('never fires a second time in the same session, even after the first resync settles', async () => {
    vi.mocked(s3Api.resyncS3Backfill).mockResolvedValue(undefined)
    const startBackfill = vi.fn()

    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, false))
    await act(async () => { result.current() })
    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)

    act(() => { result.current() })
    act(() => { result.current() })
    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)
  })

  it('does not fire while a backfill is already active', () => {
    const startBackfill = vi.fn()
    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: true, startBackfill }, false))

    act(() => { result.current() })

    expect(s3Api.resyncS3Backfill).not.toHaveBeenCalled()
  })

  it('does not fire while blocked (e.g. Settings modal open)', () => {
    const startBackfill = vi.fn()
    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, true))

    act(() => { result.current() })

    expect(s3Api.resyncS3Backfill).not.toHaveBeenCalled()
  })

  it('a blocked call does not consume the once-per-session guard — a later unblocked call still fires', () => {
    const startBackfill = vi.fn()
    vi.mocked(s3Api.resyncS3Backfill).mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ blocked }) => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, blocked),
      { initialProps: { blocked: true } },
    )

    act(() => { result.current() })
    expect(s3Api.resyncS3Backfill).not.toHaveBeenCalled()

    rerender({ blocked: false })
    act(() => { result.current() })
    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)
  })

  it('does not reset the once-per-session guard on failure — a persistently broken resync does not retry', async () => {
    const call = deferred<void>()
    vi.mocked(s3Api.resyncS3Backfill).mockReturnValue(call.promise)
    const startBackfill = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, false))
    act(() => { result.current() })
    await act(async () => {
      call.reject(new Error('broken IAM role'))
      await call.promise.catch(() => {})
    })

    expect(startBackfill).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()

    // A later call in the same session — e.g. the user opens another
    // never-backfilled date — must not retry the failing resync again.
    act(() => { result.current() })
    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('resets the guard on sign-out, so a different account signed into the same session gets its own auto-resync', async () => {
    vi.mocked(s3Api.resyncS3Backfill).mockResolvedValue(undefined)
    const startBackfill = vi.fn()

    const { result, rerender } = renderHook(
      ({ isSignedIn }) => useS3StaleEntryAutoResync(isSignedIn, { backfillActive: false, startBackfill }, false),
      { initialProps: { isSignedIn: true } },
    )
    await act(async () => { result.current() })
    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(1)

    rerender({ isSignedIn: false })
    rerender({ isSignedIn: true })
    await act(async () => { result.current() })

    expect(s3Api.resyncS3Backfill).toHaveBeenCalledTimes(2)
  })

  it('does not call startBackfill when resyncS3Backfill rejects', async () => {
    vi.mocked(s3Api.resyncS3Backfill).mockRejectedValue(new Error('boom'))
    const startBackfill = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, false))
    await act(async () => { result.current() })

    expect(startBackfill).not.toHaveBeenCalled()
  })
})
