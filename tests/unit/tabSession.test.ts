import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTabSession, enableTabSession, restoreTabSession, saveTabSession } from '../../src/lib/tabSession'
import { clearVaultKey, getVaultUserId, unlockVaultWithKey } from '../../src/lib/passkeyVault'

afterEach(() => { clearTabSession(); clearVaultKey(); vi.restoreAllMocks() })

describe('retired remembered sessions', () => {
  it('removes saved keys without unlocking or contacting the server', async () => {
    localStorage.setItem('linger_device_session_v1', JSON.stringify({ userId: 'old', key: 'secret' }))
    sessionStorage.setItem('linger_tab_session_v1', JSON.stringify({ userId: 'old', key: 'secret' }))
    localStorage.setItem('unrelated-draft', 'keep')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await restoreTabSession()).toBe('missing')
    expect(getVaultUserId()).toBeNull()
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
    expect(sessionStorage.getItem('linger_tab_session_v1')).toBeNull()
    expect(localStorage.getItem('unrelated-draft')).toBe('keep')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never persists an unlocked key even if legacy callers request it', () => {
    unlockVaultWithKey('user', new Uint8Array(32).fill(7))
    enableTabSession(7)
    saveTabSession()
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
    expect(sessionStorage.getItem('linger_tab_session_v1')).toBeNull()
    expect(getVaultUserId()).toBe('user')
  })
})
