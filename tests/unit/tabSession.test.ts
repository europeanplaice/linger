import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearVaultKey, getVaultUserId, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { clearOAuthCredentials, getAccessToken, setOAuthCredentials } from '../../src/lib/oauthCredentials'
import { clearTabSession, enableTabSession, restoreTabSession, saveTabSession } from '../../src/lib/tabSession'

describe('optional tab session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
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
    expect(sessionStorage.length).toBe(0)
    enableTabSession()
    saveTabSession()
    expect(sessionStorage.getItem('linger_tab_session_v1')).not.toContain('access')
    expect(sessionStorage.getItem('linger_tab_session_v1')).not.toContain('identity')
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
    expect(sessionStorage.length).toBe(0)
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
    vi.advanceTimersByTime(8 * 60 * 60 * 1000)
    expect(sessionStorage.length).toBe(0)
  })
})
