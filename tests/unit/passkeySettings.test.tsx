import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PasskeySettings } from '../../src/components/PasskeySettings'
import { I18nProvider } from '../../src/i18n'
import * as passkeys from '../../src/api/passkeys'

vi.mock('../../src/api/passkeys', () => ({
  deletePasskey: vi.fn(),
  listPasskeys: vi.fn(),
}))

const records = [
  { credentialId: 'current-id', createdAt: 1_800_000_000_000 },
  { credentialId: 'backup-id', createdAt: 1_800_000_100_000 },
]

beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
  vi.mocked(passkeys.listPasskeys).mockResolvedValue({ credentials: records, currentCredentialId: 'current-id' })
  vi.mocked(passkeys.deletePasskey).mockResolvedValue()
})

function renderSettings() {
  return render(<I18nProvider initialLanguage="en"><PasskeySettings userId="user-id" busy={false} error={null} onAdd={async () => {}} /></I18nProvider>)
}

describe('PasskeySettings', () => {
  it('shows the active passkey and never offers to delete it', async () => {
    renderSettings()
    await screen.findByText('Current sign-in passkey')
    expect(screen.getByText('Passkey current-…')).toBeTruthy()
    expect(screen.getByText('Passkey backup-i…')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    expect(screen.getByText('Current sign-in passkey').closest('li')?.querySelector('button')).toBeNull()
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
})
