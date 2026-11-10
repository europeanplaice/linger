import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../../src/hooks/useAuth'

const mocks = vi.hoisted(() => ({
  start: vi.fn(), session: vi.fn(), refresh: vi.fn(), register: vi.fn(), login: vi.fn(), vaultId: vi.fn(),
}))
vi.mock('../../src/api/auth', () => ({
  startSignIn: mocks.start, checkSession: mocks.session, refreshGoogleCredentials: mocks.refresh,
  clearPendingGoogleCredential: vi.fn(), revokeSession: vi.fn(),
  hasPendingGoogleCredential: vi.fn().mockReturnValue(false),
}))
vi.mock('../../src/api/passkeys', () => ({ registerPasskey: mocks.register, loginWithPasskey: mocks.login, addPasskey: vi.fn() }))
vi.mock('../../src/lib/passkeyVault', () => ({ getVaultUserId: mocks.vaultId, clearVaultKey: vi.fn() }))
vi.mock('../../src/lib/tabSession', () => ({ clearTabSession: vi.fn(), enableTabSession: vi.fn(), restoreTabSession: vi.fn().mockResolvedValue(false), saveTabSession: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.vaultId.mockReturnValue(null)
  mocks.session.mockResolvedValue({ signedIn: false, email: null })
  mocks.refresh.mockResolvedValue(true)
})

afterEach(() => vi.restoreAllMocks())

describe('Google-first registration', () => {
  it('remembers dismissal after locking and after remounting without enabling device persistence', async () => {
    mocks.login.mockImplementation(async () => {
      mocks.vaultId.mockReturnValue('existing-vault')
      return { userId: 'existing-vault' }
    })
    const first = renderHook(() => useAuth())
    await waitFor(() => expect(first.result.current.status).toBe('signedOut'))
    await act(async () => first.result.current.unlockPasskey())
    expect(first.result.current.offerRememberDevice).toBe(true)
    act(() => first.result.current.dismissRememberDevice())
    act(() => first.result.current.lockVault())
    await act(async () => first.result.current.unlockPasskey())
    expect(first.result.current.offerRememberDevice).toBe(false)
    first.unmount()

    mocks.vaultId.mockReturnValue(null)
    const second = renderHook(() => useAuth())
    await waitFor(() => expect(second.result.current.status).toBe('signedOut'))
    await act(async () => second.result.current.unlockPasskey())
    expect(second.result.current.offerRememberDevice).toBe(false)
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
  })

  it('still remembers dismissal on the current page when browser storage is blocked', async () => {
    mocks.login.mockImplementation(async () => {
      mocks.vaultId.mockReturnValue('existing-vault')
      return { userId: 'existing-vault' }
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => result.current.unlockPasskey())
    expect(result.current.offerRememberDevice).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    act(() => result.current.dismissRememberDevice())
    act(() => result.current.lockVault())
    await act(async () => result.current.unlockPasskey())
    expect(result.current.offerRememberDevice).toBe(false)
  })

  it('uses the verified Google email for the passkey, then stores the refresh credential', async () => {
    mocks.start.mockResolvedValue({ email: 'person@example.com' })
    mocks.register.mockImplementation(async () => {
      mocks.vaultId.mockReturnValue('new-vault')
      mocks.session.mockResolvedValue({ signedIn: true, userId: 'new-vault', email: 'person@example.com', googleSub: 'sub', googleClientId: 'client' })
      return { userId: 'new-vault' }
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    act(() => result.current.beginSetup())
    await waitFor(() => expect(result.current.setupEmail).toBe('person@example.com'))
    await act(async () => result.current.setupPasskey())
    expect(mocks.start).toHaveBeenCalledWith({ setup: true, selectAccount: true })
    expect(mocks.register).toHaveBeenCalledWith(expect.any(AbortSignal), 'person@example.com', expect.any(Function))
    expect(mocks.refresh).toHaveBeenCalledWith(true)
    expect(result.current.status).toBe('signedIn')
  })

  it('restores Google authorization after a saved passkey is unlocked', async () => {
    mocks.login.mockImplementation(async () => {
      mocks.vaultId.mockReturnValue('existing-vault')
      return { userId: 'existing-vault' }
    })
    mocks.refresh.mockImplementation(async () => {
      mocks.session.mockResolvedValue({ signedIn: true, userId: 'existing-vault', email: 'person@example.com', googleSub: 'sub' })
      return true
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => result.current.unlockPasskey(0, true))
    expect(mocks.login).toHaveBeenCalledWith(expect.any(AbortSignal), true)
    expect(mocks.refresh).toHaveBeenCalledWith()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(result.current.status).toBe('signedIn')
    expect(result.current.offerRememberDevice).toBe(true)
    mocks.start.mockResolvedValue({ signedIn: true, userId: 'existing-vault', email: 'person@example.com', googleSub: 'sub' })
    await act(async () => { result.current.signIn(); await Promise.resolve() })
    expect(mocks.start).toHaveBeenCalledWith({ selectAccount: false, renew: false, loginHint: 'sub' })
  })

  it('requests a new credential when unlock cannot restore Google authorization', async () => {
    mocks.login.mockImplementation(async () => {
      mocks.vaultId.mockReturnValue('existing-vault')
      return { userId: 'existing-vault' }
    })
    mocks.refresh.mockResolvedValue(false)
    mocks.start.mockResolvedValue({ signedIn: true, userId: 'existing-vault', email: 'person@example.com', googleSub: 'sub' })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    await act(async () => result.current.unlockPasskey())
    await act(async () => { result.current.signIn(); await Promise.resolve() })
    expect(mocks.start).toHaveBeenCalledWith({ selectAccount: false, renew: true })
  })
})
