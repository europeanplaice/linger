// This module contains no key cache. Callers supply a user key for this request.
// Only the versioned authenticated ciphertext may cross a durable boundary.
const encoder = new TextEncoder()
const MAX_ENVELOPE_LENGTH = 128_000

export function encodeVaultBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeVaultBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid vault encoding')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  if (encodeVaultBytes(bytes) !== value) throw new Error('Invalid vault encoding')
  return bytes
}

export function validVaultKey(value: string | undefined | null): value is string {
  if (!value || value.length !== 43) return false
  try { return decodeVaultBytes(value).length === 32 } catch { return false }
}

function additionalData(userId: string, purpose: string): Uint8Array<ArrayBuffer> {
  if (!userId || !purpose) throw new Error('Vault context required')
  return new Uint8Array(encoder.encode(JSON.stringify(['linger-vault', 1, userId, purpose])))
}

async function importKey(value: string): Promise<CryptoKey> {
  if (!validVaultKey(value)) throw new Error('Vault key required')
  return crypto.subtle.importKey('raw', decodeVaultBytes(value), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sealVaultValue(key: string, userId: string, purpose: string, value: unknown): Promise<string> {
  const plaintext = encoder.encode(JSON.stringify(value))
  if (plaintext.length > 80_000) throw new Error('Vault value too large')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(userId, purpose) }, await importKey(key), plaintext)
  return `v1.${encodeVaultBytes(iv)}.${encodeVaultBytes(new Uint8Array(ciphertext))}`
}

export async function openVaultValue<T>(key: string, userId: string, purpose: string, envelope: string): Promise<T> {
  if (envelope.length > MAX_ENVELOPE_LENGTH) throw new Error('Invalid vault envelope')
  const parts = envelope.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid vault envelope')
  const iv = decodeVaultBytes(parts[1])
  const ciphertext = decodeVaultBytes(parts[2])
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid vault envelope')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(userId, purpose) }, await importKey(key), ciphertext)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)) as T
}
