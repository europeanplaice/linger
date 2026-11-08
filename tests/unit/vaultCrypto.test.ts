// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { encodeVaultBytes, openVaultValue, sealVaultValue, validVaultKey } from '../../functions/_shared/vaultCrypto'

const randomKey = () => encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))

describe('request-scoped metadata encryption', () => {
  it('randomizes ciphertext and binds the account and record purpose', async () => {
    const key = randomKey()
    const value = { google_sub: 'private-google-sub', folder_id: 'private-drive-folder' }
    const first = await sealVaultValue(key, 'user-a', 'account-metadata', value)
    const second = await sealVaultValue(key, 'user-a', 'account-metadata', value)
    expect(first).not.toBe(second)
    expect(first).not.toContain(value.google_sub)
    expect(first).not.toContain(value.folder_id)
    expect(first).not.toContain(key)
    expect(await openVaultValue(key, 'user-a', 'account-metadata', first)).toEqual(value)
    await expect(openVaultValue(randomKey(), 'user-a', 'account-metadata', first)).rejects.toThrow()
    await expect(openVaultValue(key, 'user-b', 'account-metadata', first)).rejects.toThrow()
    await expect(openVaultValue(key, 'user-a', 'folder-cache', first)).rejects.toThrow()
  })

  it('rejects plaintext, tampered, malformed, and oversized envelopes', async () => {
    const key = randomKey()
    const envelope = await sealVaultValue(key, 'user-a', 'profile', { sub: 'secret' })
    const parts = envelope.split('.')
    const changed = parts[2][0] === 'A' ? 'B' : 'A'
    for (const value of ['plaintext', '{}', 'v1.a.b', `v2.${parts[1]}.${parts[2]}`, `${parts[0]}.${parts[1]}.${changed}${parts[2].slice(1)}`, 'x'.repeat(128_001)]) {
      await expect(openVaultValue(key, 'user-a', 'profile', value)).rejects.toThrow()
    }
    expect(validVaultKey(key)).toBe(true)
    expect(validVaultKey('a'.repeat(43))).toBe(false)
    expect(validVaultKey(key + '=')).toBe(false)
  })
})
