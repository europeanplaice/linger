import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('Google-first registration', () => {
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
    expect(mocks.register).toHaveBeenCalledWith(expect.any(AbortSignal), 'person@example.com')
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
    await act(async () => result.current.unlockPasskey())
    expect(mocks.refresh).toHaveBeenCalledWith()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(result.current.status).toBe('signedIn')
  })
})
