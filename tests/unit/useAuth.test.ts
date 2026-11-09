import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAuth } from '../../src/hooks/useAuth'
import { AUTH_EVENT_KEY, getAccountSnapshot, setActiveAccount } from '../../src/lib/accountSession'
import { clearOAuthCredentials, getAccessToken, setOAuthCredentials } from '../../src/lib/oauthCredentials'

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
  clearOAuthCredentials()
  setActiveAccount(null, true)
  mockStartSignIn.mockReset()
  mockStartSignIn.mockResolvedValue({ signedIn: true, email: 'user@example.com', googleSub: 'google-sub-123', googleClientId: 'client-id' })
  mockCheckSession.mockReset()
  mockCheckSession.mockResolvedValue({ signedIn: false, email: null })
  mockRevokeSession.mockReset()
})

describe('useAuth', () => {
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
    expect(mockStartSignIn).toHaveBeenCalledWith({ selectAccount: false })
  })

  it('requests account selection for the explicit alternate-account action', async () => {
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => { result.current.signIn({ selectAccount: true }); await Promise.resolve() })
    expect(mockStartSignIn).toHaveBeenCalledWith({ selectAccount: true })
  })

  it('tracks popup reauthentication and exposes failure for the in-place recovery UI', async () => {
    mockStartSignIn.mockRejectedValueOnce(new Error('popup blocked'))
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    await act(async () => { result.current.signIn() })

    expect(result.current.signingIn).toBe(false)
    expect(result.current.authError).toBe('sign_in_failed')
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
