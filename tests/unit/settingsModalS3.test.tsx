import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SettingsModal } from '../../src/components/SettingsModal'
import { I18nProvider } from '../../src/i18n'
import * as s3Api from '../../src/api/s3Settings'

vi.mock('../../src/api/s3Settings', () => ({
  loadS3Settings: vi.fn(),
  saveS3Settings: vi.fn(),
  testS3Settings: vi.fn(),
  precheckS3Settings: vi.fn(),
  retryS3Backfill: vi.fn(),
  resyncS3Backfill: vi.fn(),
}))

// jsdom doesn't implement <dialog> methods; SettingsModal calls showModal() in an
// effect on mount regardless of which section is under test.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

const enabledSettings = {
  enabled: true,
  roleArn: 'arn:aws:iam::123456789012:role/linger-s3',
  bucket: 'my-bucket',
  region: 'us-east-1',
}

// A promise the test controls the resolution of, so it can assert on the
// UI's state while an S3 call is still in flight.
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function renderSettings() {
  const noop = () => {}
  return render(
    <I18nProvider initialLanguage="en">
      <SettingsModal
        autoSave={false}
        onAutoSaveToggle={noop}
        themeMode="system"
        onThemeModeChange={noop}
        accentColor="indigo"
        onAccentChange={noop}
        fontMode="sans"
        onFontToggle={noop}
        fontSize="md"
        onFontSizeChange={noop}
        holidayCountry="off"
        onHolidayCountryChange={noop}
        dates={[]}
        onExport={async () => []}
        onImport={async () => ({ imported: [], skipped: [], failed: [] })}
        onClose={noop}
        onSignOut={noop}
        s3BackfillProgress={null}
        s3LastSyncError={null}
        s3LastSyncErrorAt={null}
        s3BackfillActive={false}
        onS3StartBackfill={noop}
        onS3ClearSyncError={noop}
      />
    </I18nProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(s3Api.loadS3Settings).mockResolvedValue(enabledSettings)
})

describe('SettingsModal S3 backup busy-gating', () => {
  it('disables Test, Save, and Resync while Test is in flight, and re-enables them once it resolves', async () => {
    const testCall = deferred<s3Api.S3TestResult>()
    vi.mocked(s3Api.testS3Settings).mockReturnValue(testCall.promise)

    renderSettings()
    // Resync only renders once s3InitiallyEnabled is known, i.e. after the load effect settles.
    const resyncBtn = await screen.findByRole('button', { name: 'Resync all' }) as HTMLButtonElement
    const testBtn = screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement
    const saveBtn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement

    fireEvent.click(testBtn)

    const testingBtn = screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement
    expect(testingBtn.disabled).toBe(true)
    expect(saveBtn.disabled).toBe(true)
    expect(resyncBtn.disabled).toBe(true)
    // The active button shows a busy state and spinner...
    expect(testingBtn.getAttribute('aria-busy')).toBe('true')
    expect(testingBtn.querySelector('.btn-saving-spinner')).not.toBeNull()
    // ...and the blocked buttons should explain why, naming the operation, via their title tooltip.
    expect(saveBtn.title).toBe('Disabled while Test is running — wait for it to finish.')
    expect(resyncBtn.title).toBe('Disabled while Test is running — wait for it to finish.')

    testCall.resolve({ ok: true })

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect((screen.getByRole('button', { name: 'Resync all' }) as HTMLButtonElement).disabled).toBe(false)
  }, 15000)

  it('disables Test and Resync while Save is in flight', async () => {
    const saveCall = deferred<void>()
    vi.mocked(s3Api.saveS3Settings).mockReturnValue(saveCall.promise)

    renderSettings()
    const resyncBtn = await screen.findByRole('button', { name: 'Resync all' }) as HTMLButtonElement
    const testBtn = screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement
    const saveBtn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement

    fireEvent.click(saveBtn)

    expect(testBtn.disabled).toBe(true)
    expect(resyncBtn.disabled).toBe(true)
    expect(saveBtn.getAttribute('aria-busy')).toBe('true')
    expect(saveBtn.querySelector('.btn-saving-spinner')).not.toBeNull()
    expect(testBtn.title).toBe('Disabled while Save is running — wait for it to finish.')

    saveCall.resolve()

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(false)
    })
  }, 15000)

  it('disables Test and Save while Resync is in flight', async () => {
    const resyncCall = deferred<void>()
    vi.mocked(s3Api.resyncS3Backfill).mockReturnValue(resyncCall.promise)

    renderSettings()
    const resyncBtn = await screen.findByRole('button', { name: 'Resync all' }) as HTMLButtonElement
    const testBtn = screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement
    const saveBtn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement

    fireEvent.click(resyncBtn)

    expect(testBtn.disabled).toBe(true)
    expect(saveBtn.disabled).toBe(true)
    expect(resyncBtn.getAttribute('aria-busy')).toBe('true')
    expect(resyncBtn.querySelector('.btn-saving-spinner')).not.toBeNull()
    expect(saveBtn.title).toBe('Disabled while Resync is running — wait for it to finish.')

    resyncCall.resolve()

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(false)
    })
  }, 15000)
})
