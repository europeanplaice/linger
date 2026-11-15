import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntryEditor } from '../../src/components/EntryEditor'
import { I18nProvider } from '../../src/i18n'
import { getS3EntryStatus, retryS3EntrySync } from '../../src/api/s3Settings'

vi.mock('../../src/api/s3Settings', () => ({
  getS3EntryStatus: vi.fn(),
  retryS3EntrySync: vi.fn(),
}))

const date = '2026-05-01'
const noop = () => {}

function renderEditor(onS3StaleEntryDetected = vi.fn()) {
  return render(
    <I18nProvider initialLanguage="en">
      <EntryEditor
        date={date}
        getContent={async () => ({
          entry: { date, content: 'saved content' },
          meta: { id: 'file-1', name: `diary-${date}.md`, version: '1' },
        })}
        onSave={vi.fn()} onDelete={vi.fn()} onMenuClick={noop} onDirtyChange={noop}
        autoSave={false} onPrevDay={noop} onNextDay={noop} onSelectDate={noop}
        pendingNavDate={null} onPendingNavigate={noop} onCancelNavigation={noop}
        reauthSaveResult={null} isSignedIn={false} draftOwner={null} isOnline
        onExpired={noop} onS3StaleEntryDetected={onS3StaleEntryDetected}
      />
    </I18nProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('EntryEditor S3 status polling', () => {
  it('offers a retry when every status request fails', async () => {
    vi.mocked(getS3EntryStatus).mockRejectedValue(new Error('offline'))
    const onStale = vi.fn()
    await act(async () => { renderEditor(onStale) })
    await act(async () => { await vi.advanceTimersByTimeAsync(27_000) })

    expect(getS3EntryStatus).toHaveBeenCalledTimes(7)
    expect(screen.getByTitle('Couldn’t check backup status — tap to check again').classList.contains('editor-meta-badge--unverified')).toBe(true)
    expect(retryS3EntrySync).not.toHaveBeenCalled()
    expect(onStale).not.toHaveBeenCalled()
  })

  it('reports unconfirmed if a request succeeded before polling was exhausted', async () => {
    vi.mocked(getS3EntryStatus)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockRejectedValue(new Error('offline'))
    const onStale = vi.fn()
    await act(async () => { renderEditor(onStale) })
    await act(async () => { await vi.advanceTimersByTimeAsync(27_000) })

    expect(getS3EntryStatus).toHaveBeenCalledTimes(7)
    expect(screen.getByTitle('Not backed up yet — tap to retry').classList.contains('editor-meta-badge--unconfirmed')).toBe(true)
    expect(retryS3EntrySync).not.toHaveBeenCalled()
    expect(onStale).not.toHaveBeenCalled()
  })
})
