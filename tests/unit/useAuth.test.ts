import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAuth } from '../../src/hooks/useAuth'

const { mockStartSignIn, mockCheckSession, mockRevokeSession } = vi.hoisted(() => ({
  mockStartSignIn: vi.fn(),
  mockCheckSession: vi.fn().mockResolvedValue({ signedIn: false, email: null }),
  mockRevokeSession: vi.fn(),
}))

vi.mock('../../src/api/auth', () => ({
  startSignIn: mockStartSignIn,
  checkSession: mockCheckSession,
  revokeSession: mockRevokeSession,
}))

beforeEach(() => {
  mockStartSignIn.mockReset()
  mockCheckSession.mockReset()
  mockCheckSession.mockResolvedValue({ signedIn: false, email: null })
  mockRevokeSession.mockReset()
})

describe('useAuth', () => {
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

    act(() => result.current.signIn())

    expect(mockStartSignIn).toHaveBeenCalledOnce()
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

    act(() => result.current.retryAfterExpired())

    expect(mockStartSignIn).toHaveBeenCalledOnce()
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
      window.history.pushState(null, '', '/?foo=bar&auth_error=no_refresh_token#2026-01-01')

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.status).toBe('signedOut'))

      expect(result.current.authError).toBe('no_refresh_token')
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
      window.history.pushState(null, '', '/?auth_error=no_refresh_token')

      const { result } = renderHook(() => useAuth())
      await waitFor(() => expect(result.current.authError).toBe('no_refresh_token'))

      act(() => result.current.clearAuthError())

      expect(result.current.authError).toBeNull()
    })
  })
})
