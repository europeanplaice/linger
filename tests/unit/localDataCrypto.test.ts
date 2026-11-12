import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { decryptLocalData, encryptLocalData } from '../../src/lib/localDataCrypto'

afterEach(() => { clearVaultKey(); vi.restoreAllMocks() })

describe('local data encryption', () => {
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
})
