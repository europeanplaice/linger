import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenExpiredError } from '../../src/api/driveEntries'
import { continueS3Backfill, loadS3Settings } from '../../src/api/s3Settings'
import { useS3Backfill } from '../../src/hooks/useS3Backfill'

vi.mock('../../src/api/s3Settings', () => ({
  continueS3Backfill: vi.fn(),
  loadS3Settings: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe('useS3Backfill token expiry', () => {
  it('stops polling when a prepared run is already complete or empty', async () => {
    vi.mocked(loadS3Settings).mockResolvedValue({ enabled: true } as any)
    const hook = renderHook(() => useS3Backfill(true))
    await waitFor(() => expect(loadS3Settings).toHaveBeenCalledOnce())
    act(() => hook.result.current.startBackfill())
    await waitFor(() => expect(hook.result.current.backfillActive).toBe(false))
    expect(continueS3Backfill).not.toHaveBeenCalled()
  })

  it('refreshes rather than clears unresolved server errors after a settings save', async () => {
    vi.mocked(loadS3Settings).mockResolvedValue({ enabled: true, lastSyncError: 'AccessDenied' } as any)
    const hook = renderHook(() => useS3Backfill(true))
    await waitFor(() => expect(hook.result.current.lastSyncError).toBe('AccessDenied'))
    act(() => hook.result.current.startBackfill())
    await waitFor(() => expect(hook.result.current.backfillActive).toBe(false))
    expect(hook.result.current.lastSyncError).toBe('AccessDenied')
  })

  it('pauses retained progress when backup was disabled', async () => {
    vi.mocked(loadS3Settings).mockResolvedValue({ enabled: false, backfillProgress: { total: 2, done: 1, failed: [], remaining: ['2026-01-02'] } } as any)
    const hook = renderHook(() => useS3Backfill(true))
    await waitFor(() => expect(hook.result.current.backfillProgress?.done).toBe(1))
    expect(hook.result.current.backfillActive).toBe(false)
    expect(continueS3Backfill).not.toHaveBeenCalled()
  })
  it('surfaces expired credentials from the initial settings load', async () => {
    vi.mocked(loadS3Settings).mockRejectedValue(new TokenExpiredError())
    const onTokenExpired = vi.fn()
    renderHook(() => useS3Backfill(true, onTokenExpired))

    await waitFor(() => expect(onTokenExpired).toHaveBeenCalledOnce())
  })

  it('pauses browser-driven chunks and surfaces expiry when a continuation loses auth', async () => {
    vi.mocked(loadS3Settings).mockResolvedValue({
      enabled: true,
      backfillProgress: { total: 2, done: 1, failed: [], remaining: ['2026-01-02'] },
    } as any)
    vi.mocked(continueS3Backfill).mockRejectedValue(new TokenExpiredError())
    const onTokenExpired = vi.fn()
    const hook = renderHook(({ expired }) => useS3Backfill(true, onTokenExpired, expired), { initialProps: { expired: false } })

    await waitFor(() => expect(onTokenExpired).toHaveBeenCalledOnce())
    expect(continueS3Backfill).toHaveBeenCalledOnce()
    hook.rerender({ expired: true })
    const calls = vi.mocked(continueS3Backfill).mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(continueS3Backfill).toHaveBeenCalledTimes(calls)
  })
})
