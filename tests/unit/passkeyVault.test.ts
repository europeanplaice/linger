import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearVaultKey,
  createWrappedMasterKey,
  decryptVaultValue,
  encryptVaultValue,
  getVaultKey,
  parseWrappedMasterKey,
  serializeWrappedMasterKey,
  setVaultKeyHeader,
  unlockWrappedMasterKey,
  wrapExistingMasterKey,
} from '../../src/lib/passkeyVault'
import { exportVaultRecovery, parseVaultRecoveryFile } from '../../src/lib/vaultRecovery'

const prf = new Uint8Array(32).fill(0x31)

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  clearVaultKey()
})

afterEach(() => {
  clearVaultKey()
  vi.unstubAllGlobals()
})

describe('passkey vault crypto', () => {
  it('wraps one master key with multiple passkeys and unlocks the same data key', async () => {
    const firstWrapper = await createWrappedMasterKey(prf, 'user-a', 'credential-a')
    const originalKey = getVaultKey('user-a')
    expect(originalKey).not.toBeNull()
    const secondPrf = new Uint8Array(32).fill(0x72)
    const secondWrapper = await wrapExistingMasterKey(secondPrf, 'user-a', 'credential-b', originalKey!)
    originalKey!.fill(0)

    clearVaultKey()
    await unlockWrappedMasterKey(secondPrf, 'user-a', secondWrapper)
    const encrypted = await encryptVaultValue('user-a', 'google-profile', { marker: 'encrypted' })
    clearVaultKey()
    await unlockWrappedMasterKey(prf, 'user-a', firstWrapper)
    await expect(decryptVaultValue('user-a', 'google-profile', encrypted)).resolves.toEqual({ marker: 'encrypted' })
  })

  it('rejects a wrong PRF output and leaves no key unlocked', async () => {
    const wrapper = await createWrappedMasterKey(prf, 'user-a', 'credential-a')
    clearVaultKey()
    await expect(unlockWrappedMasterKey(new Uint8Array(32).fill(0x33), 'user-a', wrapper)).rejects.toThrow(/could not unlock/)
    expect(getVaultKey()).toBeNull()
  })

  it('authenticates the user and record type as AAD and detects ciphertext tampering', async () => {
    const wrapperA = await createWrappedMasterKey(prf, 'user-a', 'credential-a')
    const encrypted = await encryptVaultValue('user-a', 'google-profile', { marker: 'value' })
    await createWrappedMasterKey(new Uint8Array(32).fill(0x42), 'user-b', 'credential-b')
    const encryptedForOtherUser = await encryptVaultValue('user-b', 'google-profile', { marker: 'other' })
    clearVaultKey()
    await unlockWrappedMasterKey(prf, 'user-a', wrapperA)
    await expect(decryptVaultValue('user-a', 'google-profile', encryptedForOtherUser)).rejects.toThrow(/verified/)
    await expect(decryptVaultValue('user-a', 'drive-folder', encrypted)).rejects.toThrow(/verified/)
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + 'AAAA' }
    await expect(decryptVaultValue('user-a', 'google-profile', tampered)).rejects.toThrow(/verified/)
  })

  it('keeps raw key material in memory and clears it on lock', async () => {
    await createWrappedMasterKey(prf, 'user-a', 'credential-a')
    const firstCopy = getVaultKey('user-a')
    expect(firstCopy).toHaveLength(32)
    firstCopy!.fill(0)
    expect(getVaultKey('user-a')).toHaveLength(32)

    const headers = new Headers()
    setVaultKeyHeader(headers)
    expect(headers.get('X-Linger-Vault-Key')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(headers.get('X-Linger-Vault-User')).toBe('user-a')
    clearVaultKey()
    expect(getVaultKey()).toBeNull()
    setVaultKeyHeader(headers)
    expect(headers.has('X-Linger-Vault-Key')).toBe(false)
    expect(headers.has('X-Linger-Vault-User')).toBe(false)
  })

  it('serializes the server wrapper as IV followed by AES-GCM ciphertext', async () => {
    const wrapped = await createWrappedMasterKey(prf, 'user-a', 'credential-a')
    const payload = serializeWrappedMasterKey(wrapped)
    const raw = Uint8Array.from(atob(payload.wrappedMasterKey), character => character.charCodeAt(0))
    expect(raw).toHaveLength(12 + 48)
    expect(payload.prfSalt).toBe(wrapped.hkdfSalt)
    clearVaultKey()
    await unlockWrappedMasterKey(prf, 'user-a', parseWrappedMasterKey(payload, 'credential-a'))
    expect(getVaultKey('user-a')).toHaveLength(32)
  })

  it('exports a user-controlled recovery file without persisting it and validates imports', async () => {
    const userId = '624a7c5a-7c13-4c62-a14d-3f8c3bd516f8'
    await createWrappedMasterKey(prf, userId, 'credential-a')
    localStorage.clear()
    const file = exportVaultRecovery()
    expect(localStorage.length).toBe(0)
    const recovery = parseVaultRecoveryFile(file)
    expect(recovery.userId).toBe(userId)
    expect(recovery.masterKey).toHaveLength(32)
    recovery.masterKey.fill(0)
    await expect(Promise.resolve().then(() => parseVaultRecoveryFile('{"version":1,"userId":"user","masterKey":"bad"}'))).rejects.toThrow(/format/)
  })
})
