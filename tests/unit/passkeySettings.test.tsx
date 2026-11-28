import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PasskeySettings } from '../../src/components/PasskeySettings'
import { I18nProvider } from '../../src/i18n'
import * as passkeys from '../../src/api/passkeys'
import { retirePreviousAccounts } from '../../src/api/auth'
import { clearTabSession } from '../../src/lib/tabSession'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'

vi.mock('../../src/api/passkeys', () => ({
  deletePasskey: vi.fn(),
  listPasskeys: vi.fn(),
  renamePasskey: vi.fn(),
}))
vi.mock('../../src/api/auth', () => ({ retirePreviousAccounts: vi.fn() }))

const records = [
  { credentialId: 'current-id', createdAt: 1_800_000_000_000 },
  { credentialId: 'backup-id', createdAt: 1_800_000_100_000 },
]

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
  vi.mocked(passkeys.listPasskeys).mockResolvedValue({ credentials: records, currentCredentialId: 'current-id' })
  vi.mocked(passkeys.deletePasskey).mockResolvedValue()
  vi.mocked(passkeys.renamePasskey).mockResolvedValue()
})

afterEach(async () => { await clearTabSession(); clearVaultKey(); vi.unstubAllGlobals() })

function renderSettings() {
  return render(<I18nProvider initialLanguage="en"><PasskeySettings userId="user-id" busy={false} error={null} onAdd={async () => {}} /></I18nProvider>)
}

describe('PasskeySettings', () => {
  it('lets the user enable and forget skipping passkey on this device', async () => {
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/passkey/device-unlock' && init?.method === 'POST') {
        return new Response(JSON.stringify({ userId: 'user-id', expiresAt, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }))
    unlockVaultWithKey('user-id', new Uint8Array(32).fill(4))

    renderSettings()
    await screen.findByText('Current sign-in passkey')
    fireEvent.click(screen.getByRole('button', { name: 'Choose how to sign in next time' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skip passkey on this browser' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'How long to skip passkey' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Passkey skipped until:/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop skipping passkey on this device' }))
    expect(await screen.findByText('Saved unlock key removed. Your passkey will be required next time.')).toBeTruthy()
    expect(screen.queryByText(/Passkey skipped until:/)).toBeNull()
  })

  it('shows custom names and usage dates and submits a trimmed new name', async () => {
    vi.mocked(passkeys.listPasskeys).mockResolvedValue({ credentials: [{ ...records[0], name: 'Daily', lastUsedAt: Date.now() }], currentCredentialId: 'current-id' })
    renderSettings()
    expect(await screen.findByText('Daily')).toBeTruthy()
    expect(screen.getByText(/Last used:/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Rename' }))
    fireEvent.change(dialog.getByRole('textbox', { name: 'Passkey name' }), { target: { value: '  Backup  ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(passkeys.renamePasskey).toHaveBeenCalledWith('user-id', 'current-id', 'Backup'))
    expect(await screen.findByText('Passkey name saved.')).toBeTruthy()
  })
  it('shows the active passkey and never offers to delete it', async () => {
    renderSettings()
    await screen.findByText('Current sign-in passkey')
    expect(screen.getByText('Passkey current-…')).toBeTruthy()
    expect(screen.getByText('Passkey backup-i…')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    expect(within(screen.getByText('Current sign-in passkey').closest('li')!).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('requires confirmation before deleting another saved credential', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('dialog', { name: 'Remove this passkey?' })).toBeTruthy()
    expect(screen.getByText(/will no longer be able to sign in to Linger/)).toBeTruthy()
    expect(passkeys.deletePasskey).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove passkey' }))
    await waitFor(() => expect(passkeys.deletePasskey).toHaveBeenCalledWith('user-id', 'backup-id'))
    expect((await screen.findByRole('status')).textContent).toContain('Passkey removed.')
  })

  it('does not offer deletion when only one credential is saved', async () => {
    vi.mocked(passkeys.listPasskeys).mockResolvedValue({ credentials: [records[0]], currentCredentialId: 'current-id' })
    renderSettings()
    await screen.findByText('Current sign-in passkey')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('requires confirming that the diary opens before starting Google recovery', async () => {
    vi.mocked(retirePreviousAccounts).mockResolvedValue(1)
    renderSettings()
    fireEvent.click(await screen.findByText('Retire previous accounts’ passkeys'))
    const proceed = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm with Google' })
    expect(proceed.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I can open my diary with this passkey.' }))
    fireEvent.click(proceed)
    expect(await screen.findByText('Matching older passkeys and sessions were disabled.')).toBeTruthy()
    expect(retirePreviousAccounts).toHaveBeenCalledOnce()
  })
})
