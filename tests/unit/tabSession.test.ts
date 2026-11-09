import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearVaultKey, getVaultUserId, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { clearOAuthCredentials, getAccessToken, setOAuthCredentials } from '../../src/lib/oauthCredentials'
import { clearTabSession, enableTabSession, restoreTabSession, saveTabSession } from '../../src/lib/tabSession'

describe('optional tab session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
    localStorage.clear()
    clearTabSession()
    clearVaultKey()
    clearOAuthCredentials()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  })
  afterEach(() => { clearTabSession(); clearVaultKey(); clearOAuthCredentials(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('only saves after opt-in and restores after validating the server session', async () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    setOAuthCredentials({ accessToken: 'access', idToken: 'identity', expiresAt: Date.now() + 60_000 })
    saveTabSession()
    expect(localStorage.length).toBe(0)
    enableTabSession()
    saveTabSession()
    expect(localStorage.getItem('linger_device_session_v1')).not.toContain('access')
    expect(localStorage.getItem('linger_device_session_v1')).not.toContain('identity')
    sessionStorage.clear() // A new browser session still has the device record.
    clearVaultKey()
    clearOAuthCredentials()
    expect(await restoreTabSession()).toBe(true)
    expect(getVaultUserId()).toBe('user')
    expect(getAccessToken()).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/auth/passkey/session', expect.objectContaining({ credentials: 'include', cache: 'no-store' }))
  })

  it('removes legacy Google credentials before validating the session', async () => {
    sessionStorage.setItem('linger_tab_session_v1', JSON.stringify({
      userId: 'user', key: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), expiresAt: Date.now() + 60_000,
      oauth: { accessToken: 'legacy-access', idToken: 'legacy-identity', expiresAt: Date.now() + 60_000 },
    }))
    vi.mocked(fetch).mockImplementation(async () => {
      expect(sessionStorage.getItem('linger_tab_session_v1')).not.toContain('legacy-')
      return new Response(null, { status: 200 })
    })
    expect(await restoreTabSession()).toBe(true)
    expect(getVaultUserId()).toBe('user')
    expect(getAccessToken()).toBeNull()
  })

  it('rejects revoked sessions and removes their stored credentials', async () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    enableTabSession()
    saveTabSession()
    clearVaultKey()
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    expect(await restoreTabSession()).toBe(false)
    expect(getVaultUserId()).toBeNull()
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
  })

  it('expires the saved session', async () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    setOAuthCredentials({ accessToken: 'access', idToken: 'identity', expiresAt: Date.now() + 60_000 })
    enableTabSession()
    saveTabSession()
    clearVaultKey()
    clearOAuthCredentials()
    vi.advanceTimersByTime(61_000)
    expect(await restoreTabSession()).toBe(true)
    expect(getVaultUserId()).toBe('user')
    expect(getAccessToken()).toBeNull()
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000)
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
  })

  it('does not extend the expiry when saving or restoring', async () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    enableTabSession()
    saveTabSession()
    const initial = JSON.parse(localStorage.getItem('linger_device_session_v1')!).expiresAt
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    clearVaultKey()
    expect(await restoreTabSession()).toBe(true)
    saveTabSession()
    expect(JSON.parse(localStorage.getItem('linger_device_session_v1')!).expiresAt).toBe(initial)
  })

  it('does not restore a key removed during validation', async () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    enableTabSession()
    saveTabSession()
    clearVaultKey()
    vi.mocked(fetch).mockImplementation(async () => {
      localStorage.removeItem('linger_device_session_v1')
      return new Response(null, { status: 200 })
    })
    expect(await restoreTabSession()).toBe(false)
    expect(getVaultUserId()).toBeNull()
  })

  it('does not recreate a device record removed by another tab', () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    enableTabSession()
    saveTabSession()
    localStorage.removeItem('linger_device_session_v1')
    saveTabSession()
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
  })
})
