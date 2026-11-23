import { getVaultLocalDerivationKey, getVaultRevision, getVaultUserId } from './passkeyVault'

/** Encrypted payload for browser-local data. This format is not used by Drive. */
export interface LocalDataEnvelope {
  version: 1
  iv: string
  ciphertext: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const draftKeyInfo = encoder.encode('linger/local-data/aes-gcm/v1')
const lookupKeyInfo = encoder.encode('linger/local-data/lookup-hmac/v1')
const salt = encoder.encode('linger/local-data/hkdf-sha256/v1')

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function encode(value: Uint8Array): string {
  let result = ''
  for (let i = 0; i < value.length; i += 0x8000) result += String.fromCharCode(...value.subarray(i, i + 0x8000))
  return btoa(result)
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value)
  return Uint8Array.from(text, char => char.charCodeAt(0))
}

function aad(userId: string, kind: string, recordId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['linger-local', 1, userId, kind, recordId]))
}

async function withDerivedKey<T>(
  userId: string,
  keyInfo: Uint8Array<ArrayBuffer>,
  algorithm: AesDerivedKeyParams | HmacImportParams,
  usages: KeyUsage[],
  operation: (key: CryptoKey) => Promise<T>,
): Promise<T> {
  const material = getVaultLocalDerivationKey(userId)
  if (!material) throw new Error('Passkey unlock required')
  const revision = getVaultRevision()
  const assertCurrent = () => {
    if (getVaultRevision() !== revision || getVaultUserId() !== userId) {
      throw new Error('Passkey vault changed during local data operation')
    }
  }
  const base = await material
  assertCurrent()
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: keyInfo },
    base, algorithm, false, usages,
  )
  assertCurrent()
  const result = await operation(key)
  assertCurrent()
  return result
}

function withEncryptionKey<T>(userId: string, kind: string, operation: (key: CryptoKey) => Promise<T>): Promise<T> {
  // Drafts and their key markers share the original derivation parameters.
  const keyInfo = kind === 'draft' || kind === 'draft-key-marker' ? draftKeyInfo : encoder.encode(`linger/local-data/aes-gcm/v1/${kind}`)
  return withDerivedKey(userId, keyInfo, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt'], operation)
}

/** Opaque, account-specific identifier for an IndexedDB record. */
export async function localDataLookupKey(userId: string, kind: string, recordId: string): Promise<string> {
  if (!userId || !kind || !recordId) throw new Error('Local data identity required')
  return withDerivedKey(userId, lookupKeyInfo, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'], async key => {
    const digest = await crypto.subtle.sign('HMAC', key, buffer(aad(userId, kind, recordId)))
    return encode(new Uint8Array(digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  })
}

export async function encryptLocalData<T>(userId: string, kind: string, recordId: string, value: T): Promise<LocalDataEnvelope> {
  if (!kind || !recordId) throw new Error('Local data identity required')
  const plaintext = JSON.stringify(value)
  if (plaintext === undefined) throw new Error('Local data cannot be serialized')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await withEncryptionKey(userId, kind, key => crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad(userId, kind, recordId)), tagLength: 128 },
    key, buffer(encoder.encode(plaintext)),
  ))
  return { version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) }
}

export async function decryptLocalData<T>(userId: string, kind: string, recordId: string, envelope: LocalDataEnvelope): Promise<T> {
  if (!kind || !recordId || envelope.version !== 1) throw new Error('Invalid local data envelope')
  const iv = decode(envelope.iv)
  if (iv.length !== 12) throw new Error('Invalid local data IV')
  const plaintext = await withEncryptionKey(userId, kind, key => crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad(userId, kind, recordId)), tagLength: 128 },
    key, buffer(decode(envelope.ciphertext)),
  ))
  return JSON.parse(decoder.decode(plaintext)) as T
}
