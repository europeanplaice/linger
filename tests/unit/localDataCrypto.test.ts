import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearVaultKey, getVaultLocalDerivationKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { decryptLocalData, encryptLocalData, localDataLookupKey } from '../../src/lib/localDataCrypto'

afterEach(() => { clearVaultKey(); vi.restoreAllMocks() })

describe('local data encryption', () => {
  it('imports one non-extractable derivation key per unlock and preserves v1 records and lookups', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const masterKey = new Uint8Array(32).fill(7)
    unlockVaultWithKey('user-a', masterKey)
    const derivationKey = await getVaultLocalDerivationKey('user-a')
    expect(derivationKey).toMatchObject({ extractable: false, usages: ['deriveKey'] })
    expect(getVaultLocalDerivationKey('user-b')).toBeNull()

    // Known values for the pre-existing v1 AES-GCM envelope and HMAC index.
    const existingDraft = {
      version: 1 as const,
      iv: 'AQEBAQEBAQEBAQEB',
      ciphertext: 'x/Hn6txyRTvtbrJN7iWdGrwEVt1OvLPnWE1u0oWDsneoDZl3mezXJ75qHbd+msuGNnkACA==',
    }
    const [draft, lookup] = await Promise.all([
      decryptLocalData('user-a', 'draft', 'date-a', existingDraft),
      localDataLookupKey('user-a', 'draft', 'date-a'),
    ])
    expect(draft).toEqual({ content: 'previously saved draft' })
    expect(lookup).toBe('VKvi26fWOtKqOWbRZJhVTp3QJkkwfxdCGuXPXXZDv44')
    expect(importKey).toHaveBeenCalledTimes(1)

    clearVaultKey()
    expect(getVaultLocalDerivationKey('user-a')).toBeNull()
    unlockVaultWithKey('user-a', masterKey)
    expect(await getVaultLocalDerivationKey('user-a')).not.toBe(derivationKey)
    expect(importKey).toHaveBeenCalledTimes(2)
    await expect(localDataLookupKey('user-a', 'draft', 'date-a')).resolves.toBe(lookup)
  })

  it('encrypts and authenticates content and its record identity', async () => {
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(7))
    const value = { content: 'private diary text', baseContent: 'earlier text' }
    const encrypted = await encryptLocalData('user-a', 'draft', 'date-a', value)
    expect(JSON.stringify(encrypted)).not.toContain(value.content)
    expect(await decryptLocalData('user-a', 'draft', 'date-a', encrypted)).toEqual(value)
    await expect(decryptLocalData('user-a', 'draft', 'date-b', encrypted)).rejects.toThrow()
    await expect(decryptLocalData('user-a', 'cache', 'date-a', encrypted)).rejects.toThrow()
    const bytes = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0))
    bytes[0] ^= 1
    await expect(decryptLocalData('user-a', 'draft', 'date-a', { ...encrypted, ciphertext: btoa(String.fromCharCode(...bytes)) })).rejects.toThrow()
  })

  it('requires the correct unlocked vault and a fresh IV for each write', async () => {
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(7))
    const first = await encryptLocalData('user-a', 'draft', 'date-a', 'text')
    const second = await encryptLocalData('user-a', 'draft', 'date-a', 'text')
    expect(first.iv).not.toBe(second.iv)
    clearVaultKey()
    await expect(decryptLocalData('user-a', 'draft', 'date-a', first)).rejects.toThrow('Passkey unlock required')
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(8))
    await expect(decryptLocalData('user-a', 'draft', 'date-a', first)).rejects.toThrow()
    unlockVaultWithKey('user-b', new Uint8Array(32).fill(7))
    await expect(decryptLocalData('user-a', 'draft', 'date-a', first)).rejects.toThrow('Passkey unlock required')
  })

  it('rejects an operation if the vault is locked and reopened while encrypting', async () => {
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(7))
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      started()
      await gate
      return encrypt(...args)
    })
    const pending = encryptLocalData('user-a', 'draft', 'date-a', 'text')
    await running
    clearVaultKey()
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(7))
    proceed()
    await expect(pending).rejects.toThrow('Passkey vault changed')
  })

  it('discards key initialization from an earlier unlock', async () => {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle)
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    vi.spyOn(crypto.subtle, 'importKey').mockImplementationOnce(async (...args) => {
      const key = await importKey(...args)
      await gate
      return key
    })
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(7))
    const pending = localDataLookupKey('user-a', 'draft', 'date-a')
    unlockVaultWithKey('user-a', new Uint8Array(32).fill(8))
    proceed()
    await expect(pending).rejects.toThrow('Passkey vault changed')
    expect(deriveKey).not.toHaveBeenCalled()
    await expect(localDataLookupKey('user-a', 'draft', 'date-a')).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
