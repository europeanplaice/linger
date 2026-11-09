import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { deletePasskey, listPasskeys, loginWithPasskey, registerPasskey } from '../../src/api/passkeys'
import { clearVaultKey, createWrappedMasterKey, serializeWrappedMasterKey } from '../../src/lib/passkeyVault'

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

afterEach(() => {
  clearVaultKey()
  vi.unstubAllGlobals()
})

it('sends only same-origin passkey routes and strips PRF bytes from assertion JSON', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('PublicKeyCredential', class {})
  vi.stubGlobal('AuthenticatorAssertionResponse', class {})
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })

  const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
  const prfOutput = new Uint8Array(32).fill(0x5d)
  const credentialId = new Uint8Array([1, 2, 3, 4])
  const credentialIdEncoded = toBase64Url(credentialId)
  const wrapper = serializeWrappedMasterKey(await createWrappedMasterKey(prfOutput, userId, credentialIdEncoded))
  clearVaultKey()

  const credential = Object.assign(new (window.PublicKeyCredential as unknown as { new(): object })(), {
    id: credentialIdEncoded,
    rawId: credentialId.buffer,
    type: 'public-key',
    response: Object.assign(new (window.AuthenticatorAssertionResponse as unknown as { new(): object })(), {
      authenticatorData: new Uint8Array([1]).buffer,
      clientDataJSON: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    }),
    getClientExtensionResults: () => ({ prf: { results: { first: prfOutput.buffer } } }),
    toJSON: () => ({
      id: credentialIdEncoded,
      rawId: credentialIdEncoded,
      type: 'public-key',
      response: { authenticatorData: 'AQ', clientDataJSON: 'Ag', signature: 'Aw', userHandle: null },
      clientExtensionResults: { prf: { results: { first: toBase64Url(prfOutput) } } },
    }),
  })
  const credentialsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'credentials')
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: vi.fn().mockResolvedValue(credential) } })

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path !== '/auth/passkey/login/options' && path !== '/auth/passkey/login/verify') throw new Error(`Unexpected passkey path: ${path}`)
    expect(init?.redirect).toBe('error')
    if (path.endsWith('/options')) return new Response(JSON.stringify({ options: { challenge: 'AQ', rpId: 'example.com' }, prfInput: 'Ag' }), { status: 200 })
    const body = JSON.parse(String(init?.body)) as { response: { clientExtensionResults: { prf: Record<string, unknown> } } }
    expect(body.response.clientExtensionResults.prf).toEqual({ enabled: true })
    expect(JSON.stringify(body)).not.toContain(toBase64Url(prfOutput))
    return new Response(JSON.stringify({ userId, credentialId: credentialIdEncoded, wrapper }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    await expect(loginWithPasskey()).resolves.toEqual({ userId })
    expect(navigator.credentials.get).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    if (credentialsDescriptor) Object.defineProperty(navigator, 'credentials', credentialsDescriptor)
  }
})

it('lists and deletes other passkeys with the unlocked vault session headers', async () => {
  class FakeCredential {}
  vi.stubGlobal('PublicKeyCredential', FakeCredential)
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  const credential = Object.assign(new FakeCredential(), {
    id: 'AQ', rawId: new Uint8Array([1]).buffer,
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).buffer } } }),
    toJSON: () => ({ id: 'AQ', rawId: 'AQ', type: 'public-key', response: {} }),
  })
  const credentialsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'credentials')
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: vi.fn().mockResolvedValue(credential) } })
  const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
  await createWrappedMasterKey(new Uint8Array(32).fill(7), userId, 'cred')
  const credentials = [{ credentialId: 'cred-1', createdAt: 1_800_000_000_000 }]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    expect(init?.redirect).toBe('error')
    expect(init?.method).toBe('POST')
    if (path.endsWith('/login/options')) return new Response(JSON.stringify({ options: { challenge: 'AQ' }, prfInput: 'Ag' }), { status: 200 })
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Linger-Vault-User')).toBe(userId)
    expect(headers.get('X-Linger-Vault-Key')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (path.endsWith('/login/verify')) {
      expect(JSON.parse(String(init?.body)).managementAction).toBe('delete')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (path.endsWith('/credentials/list')) {
      expect(JSON.parse(String(init?.body))).toEqual({})
      return new Response(JSON.stringify({ credentials, currentCredentialId: 'cred-current' }), { status: 200 })
    }
    expect(path).toBe('/auth/passkey/credentials/delete')
    expect(JSON.parse(String(init?.body))).toEqual({ credentialId: 'cred-1' })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    await expect(listPasskeys(userId)).resolves.toEqual({ credentials, currentCredentialId: 'cred-current' })
    await expect(deletePasskey(userId, 'cred-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  } finally {
    if (credentialsDescriptor) Object.defineProperty(navigator, 'credentials', credentialsDescriptor)
  }
})

it('strips PRF outputs from both the attestation and verification assertion sent to the server', async () => {
  vi.stubGlobal('crypto', webcrypto)
  class FakePublicKeyCredential {}
  class FakeAttestationResponse {}
  class FakeAssertionResponse {}
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential)
  vi.stubGlobal('AuthenticatorAttestationResponse', FakeAttestationResponse)
  vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertionResponse)
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })

  const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
  const credentialId = new Uint8Array([8, 7, 6, 5])
  const credentialIdEncoded = toBase64Url(credentialId)
  const prfOutput = new Uint8Array(32).fill(0x5d)
  const created = Object.assign(new FakePublicKeyCredential(), {
    id: credentialIdEncoded,
    rawId: credentialId.buffer,
    type: 'public-key',
    response: Object.assign(new FakeAttestationResponse(), {
      attestationObject: new Uint8Array([4]).buffer,
      clientDataJSON: new Uint8Array([5]).buffer,
      getTransports: () => ['internal'],
    }),
    getClientExtensionResults: () => ({ prf: { enabled: true } }),
    toJSON: () => ({ id: credentialIdEncoded, rawId: credentialIdEncoded, type: 'public-key', response: { attestationObject: 'BA', clientDataJSON: 'BQ' }, clientExtensionResults: { prf: { enabled: true } } }),
  })
  const assertion = Object.assign(new FakePublicKeyCredential(), {
    id: credentialIdEncoded,
    rawId: credentialId.buffer,
    type: 'public-key',
    response: Object.assign(new FakeAssertionResponse(), {
      authenticatorData: new Uint8Array([6]).buffer,
      clientDataJSON: new Uint8Array([7]).buffer,
      signature: new Uint8Array([8]).buffer,
      userHandle: new TextEncoder().encode(userId).buffer,
    }),
    getClientExtensionResults: () => ({ prf: { results: { first: prfOutput.buffer } } }),
    toJSON: () => ({ id: credentialIdEncoded, rawId: credentialIdEncoded, type: 'public-key', response: { authenticatorData: 'Bg', clientDataJSON: 'Bw', signature: 'CA', userHandle: 'dXNlcg' }, clientExtensionResults: { prf: { results: { first: toBase64Url(prfOutput) } } } }),
  })
  const credentialsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'credentials')
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: vi.fn().mockResolvedValue(created), get: vi.fn().mockResolvedValue(assertion) } })
  const prfSalt = toBase64Url(new Uint8Array(32).fill(3))
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    expect(init?.redirect).toBe('error')
    if (path.endsWith('/register/options')) return new Response(JSON.stringify({
      userId,
      prfInput: 'Ag',
      prfSalt,
      options: { challenge: 'AQ', rp: { id: 'example.com', name: 'Linger' }, user: { id: 'AQ', name: 'Linger', displayName: 'Linger' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] },
      wrapOptions: { challenge: 'Aw', rpId: 'example.com', userVerification: 'required' },
    }), { status: 200 })
    expect(path).toBe('/auth/passkey/register/verify')
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Linger-Vault-User')).toBe(userId)
    expect(headers.get('X-Linger-Vault-Key')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const body = JSON.parse(String(init?.body)) as { response: { clientExtensionResults: unknown }; assertion: { clientExtensionResults: { prf: unknown } }; wrappedMasterKey: string; prfSalt: string }
    expect(body.response.clientExtensionResults).toEqual({ prf: { enabled: true } })
    expect(body.assertion.clientExtensionResults.prf).toEqual({ enabled: true })
    expect(JSON.stringify(body)).not.toContain(toBase64Url(prfOutput))
    expect(atob(body.wrappedMasterKey)).toHaveLength(60)
    return new Response(JSON.stringify({ userId }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    await expect(registerPasskey()).resolves.toEqual({ userId })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    if (credentialsDescriptor) Object.defineProperty(navigator, 'credentials', credentialsDescriptor)
  }
})
