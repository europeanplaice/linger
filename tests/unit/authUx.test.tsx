import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { I18nProvider } from '../../src/i18n'
import { PasskeyGate } from '../../src/components/PasskeyGate'
import { LoginScreen } from '../../src/components/LoginScreen'
import { RememberDevicePrompt } from '../../src/components/RememberDevicePrompt'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { clearTabSession, getDeviceSessionExpiry } from '../../src/lib/tabSession'

afterEach(() => { clearTabSession(); clearVaultKey(); vi.useRealTimers() })

function gate(props: Partial<Parameters<typeof PasskeyGate>[0]> = {}) {
  const actions = { onSetup: vi.fn(), onBeginSetup: vi.fn(), onCancelSetup: vi.fn(), onUnlock: vi.fn() }
  render(<I18nProvider initialLanguage="en"><PasskeyGate busy={false} error={null} setupEmail={null} {...actions} {...props} /></I18nProvider>)
  return actions
}

describe('authentication guidance', () => {
  it('requires acknowledgement before reconnecting a completely lost account', () => {
    const actions = gate()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByText('Having trouble with your passkey?'))
    expect(screen.getByText('Use a passkey saved on another device')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up again with the same Google account' }))
    const connect = screen.getByRole('button', { name: 'Connect Google Drive' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fireEvent.click(connect)
    expect(actions.onBeginSetup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
    fireEvent.click(connect)
    expect(actions.onBeginSetup).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Already have a Linger passkey? Sign in' }))
    expect(actions.onCancelSetup).toHaveBeenCalledOnce()
  })

  it('explains the extra verification and does not offer key persistence before registration', () => {
    const actions = gate({ setupEmail: 'person@example.com' })
    fireEvent.click(screen.getByRole('button', { name: 'First time using Linger? Get started' }))
    expect(screen.getByText(/confirm it once more/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText('Create a passkey').getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: 'Create my first Linger passkey' }))
    expect(actions.onSetup).toHaveBeenCalledWith(0)
  })

  it('announces Google connection progress separately from passkey verification', () => {
    gate({ busy: true, phase: 'google' })
    expect(screen.getByRole('status').textContent).toBe('Connecting Google Drive…')
  })

  it('localizes provider failures instead of displaying raw errors', () => {
    render(<I18nProvider initialLanguage="ja"><PasskeyGate busy={false} error="unsupported" setupEmail={null} onSetup={vi.fn()} onBeginSetup={vi.fn()} onCancelSetup={vi.fn()} onUnlock={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole('alert').textContent).toContain('対応')
    expect(screen.getByRole('alert').textContent).not.toContain('This passkey')
  })

  it('retries a connection outage without opening Google authorization', () => {
    const signIn = vi.fn(), retry = vi.fn()
    render(<I18nProvider initialLanguage="en"><LoginScreen onSignIn={signIn} onRetryConnection={retry} googleConnection="unavailable" email="person@example.com" /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(signIn).not.toHaveBeenCalled()
    expect(screen.getByText('person@example.com')).toBeTruthy()
  })

  it('keeps persistence off until the user opts in after registration', () => {
    vi.useFakeTimers()
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    const close = vi.fn()
    render(<I18nProvider initialLanguage="en"><RememberDevicePrompt onClose={close} /></I18nProvider>)
    const prompt = within(screen.getByRole('complementary'))
    expect((prompt.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(getDeviceSessionExpiry()).toBeNull()
    fireEvent.click(prompt.getByRole('checkbox'))
    expect(prompt.getByRole('option', { selected: true }).textContent).toBe('1 day')
    fireEvent.click(prompt.getByRole('button', { name: 'Save' }))
    expect(getDeviceSessionExpiry()).toBe(Date.now() + 24 * 60 * 60 * 1000)
    expect(close).toHaveBeenCalledOnce()
  })
})
