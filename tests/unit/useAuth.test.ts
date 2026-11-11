import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAuth } from '../../src/hooks/useAuth'
import { AUTH_EVENT_KEY, getAccountSnapshot, setActiveAccount } from '../../src/lib/accountSession'
import { clearOAuthCredentials, getAccessToken, setOAuthCredentials } from '../../src/lib/oauthCredentials'
import { webcrypto } from 'node:crypto'
import { rememberPasskeyRegistration } from '../../src/lib/passkeyRegistrationHistory'
import { clearVaultKey, getVaultUserId, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { loginWithPasskey } from '../../src/api/passkeys'
import { deferred } from '../helpers/deferred'

vi.mock('../../src/api/passkeys', () => ({
  loginWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
  addPasskey: vi.fn(),
}))

const { mockStartSignIn, mockCheckSession, mockRevokeSession } = vi.hoisted(() => ({
  mockStartSignIn: vi.fn(),
  mockCheckSession: vi.fn().mockResolvedValue({ signedIn: false, email: null }),
  mockRevokeSession: vi.fn(),
}))

vi.mock('../../src/api/auth', () => ({
  startSignIn: mockStartSignIn,
  checkSession: mockCheckSession,
  revokeSession: mockRevokeSession,
  refreshGoogleCredentials: vi.fn().mockResolvedValue(false),
  clearPendingGoogleCredential: vi.fn(),
  hasPendingGoogleCredential: vi.fn().mockReturnValue(false),
}))

beforeEach(() => {
  localStorage.clear()
  clearVaultKey()
  clearOAuthCredentials()
  setActiveAccount(null, true)
  vi.mocked(loginWithPasskey).mockReset()
  mockStartSignIn.mockReset()
  mockStartSignIn.mockResolvedValue({ signedIn: true, email: 'user@example.com', googleSub: 'google-sub-123', googleClientId: 'client-id' })
  mockCheckSession.mockReset()
  mockCheckSession.mockResolvedValue({ signedIn: false, email: null })
  mockRevokeSession.mockReset()
})

describe('useAuth', () => {
  it.each([false, true])('ignores a late startup session response after passkey sign-in (previously signed in: %s)', async previouslySignedIn => {
    const startup = deferred<{ signedIn: boolean; email: string | null; googleSub?: string }>()
    mockCheckSession.mockReturnValueOnce(startup.promise)
    const signedIn = { signedIn: true, email: 'user@example.com', googleSub: 'google-sub-123', userId: 'vault-user' }
    mockCheckSession.mockResolvedValue(signedIn)
    vi.mocked(loginWithPasskey).mockImplementationOnce(async () => {
      unlockVaultWithKey('vault-user', new Uint8Array(32).fill(7))
      return { userId: 'vault-user' }
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(mockCheckSession).toHaveBeenCalledTimes(1))

    await act(async () => { await result.current.unlockPasskey() })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.vaultStatus).toBe('unlocked')

    await act(async () => {
      startup.resolve(previouslySignedIn
        ? { signedIn: true, email: 'previous@example.com', googleSub: 'previous-account' }
        : { signedIn: false, email: null })
    })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.vaultStatus).toBe('unlocked')
    expect(result.current.email).toBe(signedIn.email)
    expect(getVaultUserId()).toBe('vault-user')
    expect(getAccountSnapshot().account).toBe('sub:google-sub-123')
  })

  it('keeps the passkey unlocked when startup finishes during Google restoration', async () => {
    const startup = deferred<{ signedIn: boolean; email: null }>()
    const connection = deferred<{ signedIn: boolean; email: string; googleSub: string }>()
    mockCheckSession.mockReturnValueOnce(startup.promise).mockReturnValueOnce(connection.promise)
    vi.mocked(loginWithPasskey).mockImplementationOnce(async () => {
      unlockVaultWithKey('vault-user', new Uint8Array(32).fill(7))
      return { userId: 'vault-user' }
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(mockCheckSession).toHaveBeenCalledTimes(1))

    let login!: Promise<void>
    act(() => { login = result.current.unlockPasskey() })
    await waitFor(() => expect(result.current.googleConnection).toBe('restoring'))
    await act(async () => { startup.resolve({ signedIn: false, email: null }) })
    expect(getVaultUserId()).toBe('vault-user')
    expect(result.current.vaultBusy).toBe(true)

    await act(async () => {
      connection.resolve({ signedIn: true, email: 'user@example.com', googleSub: 'google-sub-123' })
      await login
    })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.vaultStatus).toBe('unlocked')
    expect(result.current.vaultBusy).toBe(false)
  })

  it('leaves initialization when passkey sign-in supersedes startup but is cancelled', async () => {
    mockCheckSession.mockReturnValueOnce(new Promise(() => {}))
    vi.mocked(loginWithPasskey).mockRejectedValueOnce(new DOMException('Cancelled', 'NotAllowedError'))
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(mockCheckSession).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.unlockPasskey() })
    expect(result.current.status).toBe('signedOut')
    expect(result.current.vaultStatus).toBe('locked')
    expect(result.current.vaultBusy).toBe(false)
    expect(result.current.vaultError).toBe('cancelled')
  })

  it('routes an already registered email to sign-in after Google account selection, even after sign-out', async () => {
    vi.stubGlobal('crypto', webcrypto)
    try {
      await rememberPasskeyRegistration('USER@example.com')
      mockRevokeSession.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.status).toBe('signedOut'))
      act(() => result.current.signOut())
      act(() => result.current.beginSetup())
      await waitFor(() => expect(result.current.vaultError).toBe('already_registered'))
      expect(result.current.setupEmail).toBeNull()
      expect(result.current.vaultBusy).toBe(false)
      act(() => result.current.beginSetup(true))
      await waitFor(() => expect(result.current.setupEmail).toBe('user@example.com'))
      expect(result.current.vaultError).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('clears local authentication when another tab signs a different account in', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'a@example.com', googleSub: 'a' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    act(() => {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'other-tab', account: 'sub:b' }))
      window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY }))
    })
    expect(result.current.status).toBe('signedOut')
    expect(getAccountSnapshot()).toMatchObject({ account: null, clearSharedData: false })
    expect(mockRevokeSession).not.toHaveBeenCalled()
  })

  it('still clears authentication if recording the session flag fails', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'a@example.com', googleSub: 'a' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'new-account', account: 'sub:b' }))
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    try {
      act(() => { window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY })) })
      expect(result.current.status).toBe('signedOut')
    } finally { spy.mockRestore() }
  })

  it('does not restore a session response arriving after local sign-out', async () => {
    let resolve!: (info: { signedIn: boolean; email: string }) => void
    mockCheckSession.mockReturnValue(new Promise(r => { resolve = r }))
    mockRevokeSession.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())
    act(() => result.current.signOut())
    await act(async () => { resolve({ signedIn: true, email: 'a@example.com' }) })
    expect(result.current.status).toBe('signedOut')
    expect(getAccountSnapshot().account).toBeNull()
  })

  it('does not accept an old restoration response after another account signs in', async () => {
    let resolve!: (info: { signedIn: boolean; email: string }) => void
    mockCheckSession.mockReturnValue(new Promise(r => { resolve = r }))
    const { result } = renderHook(() => useAuth())
    act(() => {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'new-account', account: 'sub:b' }))
      window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY }))
    })
    await act(async () => { resolve({ signedIn: true, email: 'a@example.com' }) })
    expect(result.current.status).toBe('signedOut')
  })

  it('detects a missed auth event when the tab is focused again', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'a@example.com', googleSub: 'a' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    act(() => {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'missed', account: null }))
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current.status).toBe('signedOut')
  })

  it('initializes with status initializing', () => {
    mockCheckSession.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useAuth())
    expect(result.current.status).toBe('initializing')
  })

  it('sets signedIn when checkSession returns signedIn true', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: null })

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
  })

  it('sets signedOut when checkSession returns signedIn false', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: false, email: null })

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
  })

  it('exposes email returned by checkSession', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'user@example.com' })

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.email).toBe('user@example.com')
  })

  it('exposes null email when checkSession returns no email', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: null })

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.email).toBeNull()
  })

  it('signIn calls startSignIn', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    await act(async () => { result.current.signIn(); await Promise.resolve() })

    expect(mockStartSignIn).toHaveBeenCalledOnce()
    expect(mockStartSignIn).toHaveBeenCalledWith({ selectAccount: false, renew: true })
  })

  it('requests account selection for the explicit alternate-account action', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => { result.current.signIn({ selectAccount: true }); await Promise.resolve() })
    expect(mockStartSignIn).toHaveBeenCalledWith({ selectAccount: true, renew: true })
  })

  it('tracks popup reauthentication and exposes failure for the in-place recovery UI', async () => {
    mockStartSignIn.mockRejectedValueOnce(new Error('popup blocked'))
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    await act(async () => { result.current.signIn() })

    expect(result.current.signingIn).toBe(false)
    expect(result.current.authError).toBe('popup_blocked')
  })

  it('signOut calls revokeSession and resets status', async () => {
    mockRevokeSession.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    act(() => result.current.signOut())

    expect(mockRevokeSession).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('signedOut')
    expect(result.current.tokenExpired).toBe(false)
  })

  it('signOut does not throw when revokeSession fails', async () => {
    mockRevokeSession.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    act(() => result.current.signOut())

    await waitFor(() => {
      expect(result.current.status).toBe('signedOut')
    })
  })

  it('handleExpired sets tokenExpired to true', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    act(() => result.current.handleExpired())

    expect(result.current.tokenExpired).toBe(true)
  })

  it('retryAfterExpired calls startSignIn', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    await act(async () => { result.current.retryAfterExpired(); await Promise.resolve() })

    expect(mockStartSignIn).toHaveBeenCalledOnce()
  })

  it('rejects a different Google sub during normal reauthentication without activating it', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'a@example.com', googleSub: 'account-a' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    act(() => result.current.handleExpired())
    setOAuthCredentials({ accessToken: 'new-account-token', idToken: 'new-account-id', expiresAt: Date.now() + 60_000 })
    mockStartSignIn.mockResolvedValueOnce({ signedIn: true, email: 'b@example.com', googleSub: 'account-b' })
    await act(async () => { result.current.retryAfterExpired(); await Promise.resolve() })
    await waitFor(() => expect(result.current.authError).toBe('account_mismatch'))
    expect(result.current.status).toBe('signedIn')
    expect(result.current.googleSub).toBe('account-a')
    expect(result.current.tokenExpired).toBe(true)
    expect(getAccountSnapshot().account).toBe('sub:account-a')
    expect(getAccessToken()).toBeNull()
  })

  it('rejects a different Google sub even when the reauth popup explicitly shows account selection', async () => {
    mockCheckSession.mockResolvedValue({ signedIn: true, email: 'a@example.com', googleSub: 'account-a' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    act(() => result.current.handleExpired())
    mockStartSignIn.mockResolvedValueOnce({ signedIn: true, email: 'b@example.com', googleSub: 'account-b' })
    await act(async () => { result.current.retryAfterExpired(true); await Promise.resolve() })
    await waitFor(() => expect(result.current.authError).toBe('account_mismatch'))
    expect(result.current.googleSub).toBe('account-a')
    expect(getAccountSnapshot().account).toBe('sub:account-a')
  })

  it('updates the active account after popup sign-in resolves', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => { result.current.signIn(); await Promise.resolve() })
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.googleSub).toBe('google-sub-123')
    expect(getAccountSnapshot().account).toBe('sub:google-sub-123')
  })

  it('does not restore a popup sign-in that resolves after sign-out', async () => {
    let resolve!: (info: { signedIn: boolean; email: string; googleSub: string }) => void
    mockStartSignIn.mockReturnValue(new Promise(r => { resolve = r }))
    mockRevokeSession.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    act(() => result.current.signIn())
    act(() => result.current.signOut())
    await act(async () => { resolve({ signedIn: true, email: 'a@example.com', googleSub: 'a' }) })
    expect(result.current.status).toBe('signedOut')
    expect(getAccountSnapshot().account).toBeNull()
  })

  it('cancels checkSession on unmount', async () => {
    mockCheckSession.mockImplementation(() => new Promise(() => {}))
    const { result, unmount } = renderHook(() => useAuth())

    unmount()

    expect(result.current.status).toBe('initializing')
  })

  describe('authError', () => {
    afterEach(() => {
      window.history.pushState(null, '', '/')
    })

    it('picks up a known auth_error from the URL and strips it from the URL bar', async () => {
      window.history.pushState(null, '', '/?foo=bar&auth_error=sign_in_failed#2026-01-01')

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.status).toBe('signedOut'))

      expect(result.current.authError).toBe('sign_in_failed')
      expect(window.location.search).toBe('?foo=bar')
      expect(window.location.hash).toBe('#2026-01-01')
    })

    it('ignores unknown auth_error codes', async () => {
      window.history.pushState(null, '', '/?auth_error=something_unrecognized')

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.status).toBe('signedOut'))

      expect(result.current.authError).toBeNull()
    })

    it('clearAuthError resets authError to null', async () => {
      window.history.pushState(null, '', '/?auth_error=sign_in_failed')

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.authError).toBe('sign_in_failed'))

      act(() => result.current.clearAuthError())

      expect(result.current.authError).toBeNull()
    })

    it('signOut clears a stale authError so it does not resurface on a later sign-out', async () => {
      window.history.pushState(null, '', '/?auth_error=sign_in_failed')
      mockRevokeSession.mockResolvedValue(undefined)

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.authError).toBe('sign_in_failed'))

      act(() => result.current.signOut())

      expect(result.current.authError).toBeNull()
    })
  })
})
