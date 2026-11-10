import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../../src/hooks/useAuth'
import { clearPendingGoogleCredential, hasPendingGoogleCredential, refreshGoogleCredentials } from '../../src/api/auth'
import { getAccessToken, clearOAuthCredentials } from '../../src/lib/oauthCredentials'
import { AUTH_EVENT_KEY, setActiveAccount, getAccountSnapshot } from '../../src/lib/accountSession'
import { restoreTabSession } from '../../src/lib/tabSession'

const mocks = vi.hoisted(() => ({ userId: null as string | null, register: vi.fn(), login: vi.fn() }))
vi.mock('../../src/api/passkeys', () => ({ registerPasskey: mocks.register, loginWithPasskey: mocks.login, addPasskey: vi.fn() }))
vi.mock('../../src/lib/passkeyVault', () => ({
  getVaultUserId: () => mocks.userId,
  clearVaultKey: () => { mocks.userId = null },
  setVaultKeyHeader: (headers: Headers) => { headers.set('X-Linger-Vault-User', mocks.userId ?? '') },
}))
vi.mock('../../src/lib/tabSession', () => ({ clearTabSession: vi.fn(), enableTabSession: vi.fn(), restoreTabSession: vi.fn().mockResolvedValue(false), saveTabSession: vi.fn() }))

const refresh = vi.fn()
const renewed = () => new Response(JSON.stringify({ accessToken: 'renewed-access', idToken: 'renewed-id', expiresAt: Date.now() + 120_000 }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  mocks.userId = null
  clearPendingGoogleCredential()
  clearOAuthCredentials()
  setActiveAccount(null)
  refresh.mockReset().mockImplementation(renewed)
  const unlock = async () => { mocks.userId = 'vault-user'; return { userId: mocks.userId } }
  mocks.register.mockImplementation(unlock)
  mocks.login.mockImplementation(unlock)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/auth/refresh') return refresh(init)
    if (url === '/auth/logout') return new Response('{}')
    if (url === '/auth/session') return new Response(JSON.stringify({
      signedIn: true, userId: mocks.userId, email: 'person@example.com', googleSub: 'google-user', googleClientId: 'client',
    }))
    throw new Error(`Unexpected URL: ${url}`)
  }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearPendingGoogleCredential()
  clearOAuthCredentials()
})

async function mount() {
  const hook = renderHook(() => useAuth())
  await act(async () => {})
  expect(hook.result.current.status).toBe('signedOut')
  return hook
}

async function setup() {
  const hook = await mount()
  const popup = { closed: false, close: vi.fn() } as unknown as Window
  vi.spyOn(window, 'open').mockReturnValue(popup)
  act(() => hook.result.current.beginSetup())
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: popup, data: {
      type: 'linger-oauth-complete', credential: {
        accessToken: 'initial-access', idToken: 'initial-id', expiresAt: Date.now() + 120_000,
        refreshToken: 'pending-refresh', email: 'person@example.com',
      },
    } }))
  })
  await act(async () => hook.result.current.setupPasskey())
  return hook
}

describe('Google credential recovery', () => {
  it('preserves cached data and returning-user state during a reload outage', async () => {
    localStorage.setItem('linger_had_session', 'true')
    vi.mocked(restoreTabSession).mockImplementationOnce(async () => { mocks.userId = 'vault-user'; return true })
    refresh.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    const { result } = await mount()
    expect(result.current.googleConnection).toBe('unavailable')
    expect(result.current.vaultStatus).toBe('unlocked')
    expect(getAccountSnapshot().clearSharedData).toBe(false)
    expect(localStorage.getItem('linger_had_session')).toBe('true')
  })

  it.each(['network', '503', '429'])('keeps the unlocked vault and retries a transient login outage (%s)', async failure => {
    if (failure === 'network') refresh.mockRejectedValueOnce(new TypeError('offline'))
    else refresh.mockResolvedValueOnce(new Response('{}', { status: Number(failure) }))
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    expect(result.current.vaultStatus).toBe('unlocked')
    expect(result.current.status).toBe('signedOut')
    expect(result.current.googleConnection).toBe('unavailable')
    expect(result.current.vaultError).toBeNull()
    await act(async () => result.current.retryGoogleConnection())
    expect(result.current.status).toBe('signedIn')
    expect(result.current.googleConnection).toBe('idle')
  })

  it('automatically retries an initial outage when the connection returns', async () => {
    refresh.mockRejectedValueOnce(new TypeError('offline'))
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(result.current.status).toBe('signedIn')
  })

  it('does not retry a rejected credential automatically', async () => {
    refresh.mockResolvedValue(new Response('{}', { status: 401 }))
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    expect(result.current.googleConnection).toBe('required')
    expect(result.current.vaultStatus).toBe('unlocked')
    const calls = refresh.mock.calls.length
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(60_000) })
    expect(refresh).toHaveBeenCalledTimes(calls)
  })

  it('discards a connection retry that finishes after logout', async () => {
    refresh.mockRejectedValueOnce(new TypeError('offline'))
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    let finish!: (response: Response) => void
    refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let pending!: Promise<void>
    act(() => { pending = result.current.retryGoogleConnection() })
    await act(async () => result.current.signOut())
    await act(async () => { finish(renewed()); await pending })
    expect(result.current.status).toBe('signedOut')
    expect(result.current.vaultStatus).toBe('locked')
    expect(getAccessToken()).toBeNull()
  })

  it('does not cancel passkey login when focus returns after this tab signs out', async () => {
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    await act(async () => result.current.signOut())

    let finishLogin!: (value: { userId: string }) => void
    let signal: AbortSignal | undefined
    mocks.login.mockImplementationOnce((s: AbortSignal) => {
      signal = s
      return new Promise(resolve => { finishLogin = resolve })
    })
    let pending!: Promise<void>
    act(() => { pending = result.current.unlockPasskey() })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(signal?.aborted).toBe(false)
    await act(async () => { mocks.userId = 'vault-user'; finishLogin({ userId: 'vault-user' }); await pending })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.vaultStatus).toBe('unlocked')
  })

  it('cancels an in-progress login when another tab signs out', async () => {
    const { result } = await mount()
    let signal: AbortSignal | undefined
    mocks.login.mockImplementationOnce((s: AbortSignal) => {
      signal = s
      return new Promise(() => {})
    })
    act(() => { void result.current.unlockPasskey() })
    act(() => {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ id: 'another-tab-logout', account: null }))
      window.dispatchEvent(new StorageEvent('storage', { key: AUTH_EVENT_KEY }))
    })
    expect(signal?.aborted).toBe(true)
    expect(result.current.vaultStatus).toBe('locked')
  })

  it.each(['network', '503', '409', '429'])('retries a failed initial save (%s) with the pending credential', async failure => {
    if (failure === 'network') refresh.mockRejectedValueOnce(new TypeError('offline'))
    else refresh.mockResolvedValueOnce(new Response('{}', { status: Number(failure) }))
    const { result } = await setup()
    expect(result.current.status).toBe('signedIn')
    expect(hasPendingGoogleCredential()).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(JSON.parse(refresh.mock.calls[1][0].body)).toEqual({ refreshToken: 'pending-refresh' })
    expect(hasPendingGoogleCredential()).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(JSON.parse(refresh.mock.calls[2][0].body)).toEqual({})
  })

  it('recovers on reconnect after an outage spans access token expiry', async () => {
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    refresh.mockRejectedValue(new TypeError('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(150_000))
    expect(getAccessToken()).toBeNull()
    // An API request made with the expired access token can also report expiry.
    await act(async () => result.current.handleExpired())
    expect(result.current.tokenExpired).toBe(true)
    refresh.mockImplementation(renewed)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(result.current.tokenExpired).toBe(false)
    expect(getAccessToken()).toBe('renewed-access')
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.tokenExpired).toBe(false)
  })

  it('keeps retrying after expiry even without an online event', async () => {
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    refresh.mockResolvedValue(new Response('{}', { status: 503 }))
    await act(async () => vi.advanceTimersByTimeAsync(150_000))
    refresh.mockImplementation(renewed)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(getAccessToken()).toBe('renewed-access')
    expect(result.current.tokenExpired).toBe(false)
  })

  it('requires reauthorization when Google rejects the saved credential', async () => {
    const { result } = await mount()
    await act(async () => result.current.unlockPasskey())
    refresh.mockImplementation(() => new Response('{}', { status: 401 }))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current.tokenExpired).toBe(true)
    const calls = refresh.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(refresh).toHaveBeenCalledTimes(calls)
  })

  it('does not retry or retain a pending save after logout', async () => {
    refresh.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    const { result } = await setup()
    await act(async () => result.current.signOut())
    expect(hasPendingGoogleCredential()).toBe(false)
    const calls = refresh.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(refresh).toHaveBeenCalledTimes(calls)
  })

  it('never sends a pending credential to a different unlocked account', async () => {
    refresh.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await setup()
    mocks.userId = 'another-vault'
    expect(await refreshGoogleCredentials()).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
