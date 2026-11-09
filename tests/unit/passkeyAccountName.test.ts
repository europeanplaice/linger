import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSession } from '../../src/api/auth'

vi.mock('../../src/lib/oauthCredentials', () => ({
  getAccessToken: () => 'access', getIdToken: () => 'id',
  clearOAuthCredentials: vi.fn(), setOAuthCredentials: vi.fn(),
}))
vi.mock('../../src/lib/passkeyVault', () => ({
  getVaultUserId: () => 'user-123', setVaultKeyHeader: vi.fn(), clearVaultKey: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

describe('passkey account name', () => {
  it('signals the verified email for the unlocked passkey account', async () => {
    const signalCurrentUserDetails = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('PublicKeyCredential', { signalCurrentUserDetails })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      signedIn: true, userId: 'user-123', email: 'person@example.com', googleSub: 'sub',
    }))))

    expect((await checkSession()).signedIn).toBe(true)
    expect(signalCurrentUserDetails).toHaveBeenCalledWith({
      rpId: location.hostname, userId: 'dXNlci0xMjM', name: 'person@example.com', displayName: 'person@example.com',
    })
  })

  it('keeps login working when the provider rejects the optional update', async () => {
    vi.stubGlobal('PublicKeyCredential', { signalCurrentUserDetails: () => { throw new Error('unsupported') } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      signedIn: true, userId: 'user-123', email: 'person@example.com',
    }))))
    expect((await checkSession()).signedIn).toBe(true)
  })
})
