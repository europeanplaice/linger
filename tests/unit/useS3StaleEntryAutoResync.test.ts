import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useS3StaleEntryAutoResync } from '../../src/hooks/useS3StaleEntryAutoResync'
import * as s3Api from '../../src/api/s3Settings'

vi.mock('../../src/api/s3Settings', () => ({
  resyncS3Backfill: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

// Auto-starting an account-wide resync from a single entry's 'unconfirmed'
// status was tried and reverted (see git history on this hook) — it was
// firing account-wide backfills off single entry saves/views, which is more
// than that signal warrants. The hook is kept (rather than removed, along
// with its callers in EntryEditor/App) as a deliberate no-op so re-enabling
// it later is a small, contained change instead of re-threading a whole new
// callback through those components.
describe('useS3StaleEntryAutoResync', () => {
  it('does not auto-trigger resyncS3Backfill on stale entry detection, regardless of sign-in/blocked state', () => {
    const startBackfill = vi.fn()
    const { result } = renderHook(() => useS3StaleEntryAutoResync(true, { backfillActive: false, startBackfill }, false))
    act(() => { result.current() })
    expect(s3Api.resyncS3Backfill).not.toHaveBeenCalled()
    expect(startBackfill).not.toHaveBeenCalled()
  })
})
