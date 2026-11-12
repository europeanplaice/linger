const VAULT_KEY_HEADER = 'X-Linger-Vault-Key'
const VAULT_VERSION = 1
const WRAP_INFO = new TextEncoder().encode('linger/passkey-vault-wrap/v1')
type Bytes = Uint8Array<ArrayBuffer>

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export interface WrappedMasterKey {
  version: 1
  credentialId: string
  hkdfSalt: string
  iv: string
  ciphertext: string
}

export interface WrappedMasterKeyPayload {
  wrappedMasterKey: string
  prfSalt: string
}

export interface EncryptedVaultValue {
  version: 1
  iv: string
  ciphertext: string
}

let current: { internalUserId: string; rawKey: Bytes } | null = null
let vaultRevision = 0

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(value: string): Bytes {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function aadForWrap(internalUserId: string, credentialId: string): Bytes {
  return new TextEncoder().encode(`linger:v1:master-key:${internalUserId}:${credentialId}`)
}

function aadForRecord(internalUserId: string, recordType: string): Bytes {
  return new TextEncoder().encode(`linger:v1:metadata:${internalUserId}:${recordType}`)
}

async function deriveWrappingKey(prfOutput: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', toArrayBuffer(prfOutput), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(hkdfSalt), info: toArrayBuffer(WRAP_INFO) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptMasterKey(rawMasterKey: Uint8Array, prfOutput: Uint8Array, internalUserId: string, credentialId: string, hkdfSalt: Bytes = crypto.getRandomValues(new Uint8Array(32))): Promise<WrappedMasterKey> {
  if (rawMasterKey.length !== 32 || prfOutput.length < 32 || !internalUserId || !credentialId) {
    throw new Error('Invalid passkey vault key material')
  }
  if (hkdfSalt.length !== 32) throw new Error('Invalid passkey wrapping salt')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrappingKey = await deriveWrappingKey(prfOutput, hkdfSalt)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aadForWrap(internalUserId, credentialId)), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(rawMasterKey),
  ))
  return { version: VAULT_VERSION, credentialId, hkdfSalt: toBase64(hkdfSalt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) }
}

export async function createWrappedMasterKey(prfOutput: Uint8Array, internalUserId: string, credentialId: string, hkdfSalt?: Bytes, shouldUnlock: () => boolean = () => true): Promise<WrappedMasterKey> {
  const rawMasterKey = crypto.getRandomValues(new Uint8Array(32))
  try {
    const wrapped = await encryptMasterKey(rawMasterKey, prfOutput, internalUserId, credentialId, hkdfSalt)
    if (!shouldUnlock()) throw new DOMException('Passkey operation cancelled', 'AbortError')
    unlockVault(internalUserId, rawMasterKey)
    return wrapped
  } finally {
    rawMasterKey.fill(0)
  }
}

export async function wrapExistingMasterKey(prfOutput: Uint8Array, internalUserId: string, credentialId: string, rawMasterKey: Uint8Array, hkdfSalt?: Bytes): Promise<WrappedMasterKey> {
  return encryptMasterKey(rawMasterKey, prfOutput, internalUserId, credentialId, hkdfSalt)
}

export function serializeWrappedMasterKey(wrapped: WrappedMasterKey): WrappedMasterKeyPayload {
  const iv = fromBase64(wrapped.iv)
  const ciphertext = fromBase64(wrapped.ciphertext)
  const combined = new Uint8Array(iv.length + ciphertext.length)
  combined.set(iv)
  combined.set(ciphertext, iv.length)
  return { wrappedMasterKey: toBase64(combined), prfSalt: wrapped.hkdfSalt }
}

export function parseWrappedMasterKey(payload: WrappedMasterKeyPayload, credentialId: string): WrappedMasterKey {
  const combined = fromBase64(payload.wrappedMasterKey)
  if (combined.length < 29) throw new Error('Invalid wrapped passkey key')
  return {
    version: VAULT_VERSION,
    credentialId,
    hkdfSalt: payload.prfSalt,
    iv: toBase64(combined.subarray(0, 12)),
    ciphertext: toBase64(combined.subarray(12)),
  }
}

export async function unlockWrappedMasterKey(prfOutput: Uint8Array, internalUserId: string, wrapped: WrappedMasterKey, shouldUnlock: () => boolean = () => true): Promise<void> {
  if (wrapped.version !== VAULT_VERSION || !internalUserId || !wrapped.credentialId) throw new Error('Unsupported passkey vault record')
  const hkdfSalt = fromBase64(wrapped.hkdfSalt)
  const iv = fromBase64(wrapped.iv)
  const ciphertext = fromBase64(wrapped.ciphertext)
  const wrappingKey = await deriveWrappingKey(prfOutput, hkdfSalt)
  let rawMasterKey: Uint8Array | null = null
  try {
    rawMasterKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aadForWrap(internalUserId, wrapped.credentialId)), tagLength: 128 },
      wrappingKey,
      toArrayBuffer(ciphertext),
    ))
    if (rawMasterKey.length !== 32) throw new Error('Invalid master key')
    if (!shouldUnlock()) throw new DOMException('Passkey operation cancelled', 'AbortError')
    unlockVault(internalUserId, rawMasterKey)
  } catch {
    throw new Error('This passkey could not unlock the saved vault')
  } finally {
    rawMasterKey?.fill(0)
  }
}

function unlockVault(internalUserId: string, rawKey: Uint8Array): void {
  clearVaultKey()
  current = { internalUserId, rawKey: new Uint8Array(rawKey) }
}

/** Returns a temporary copy of the in-memory key. Callers must clear it after use. */
export function getVaultKey(internalUserId?: string): Bytes | null {
  if (!current || (internalUserId && current.internalUserId !== internalUserId)) return null
  return new Uint8Array(current.rawKey)
}

export function getVaultInternalUserId(): string | null {
  return current?.internalUserId ?? null
}

export function getVaultRevision(): number { return vaultRevision }

export const getVaultUserId = getVaultInternalUserId

export function clearVaultKey(): void {
  vaultRevision++
  current?.rawKey.fill(0)
  current = null
}

export function vaultKeyHeader(internalUserId?: string): string | null {
  const key = getVaultKey(internalUserId)
  if (!key) return null
  try { return toBase64(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') } finally { key.fill(0) }
}

export function setVaultKeyHeader(headers: Headers, internalUserId?: string): void {
  headers.delete(VAULT_KEY_HEADER)
  headers.delete('X-Linger-Vault-User')
  const value = vaultKeyHeader(internalUserId)
  const userId = internalUserId ?? current?.internalUserId
  if (value && userId) {
    headers.set(VAULT_KEY_HEADER, value)
    headers.set('X-Linger-Vault-User', userId)
  }
}

export function setVaultHeadersForKey(headers: Headers, internalUserId: string, rawKey: Uint8Array): void {
  headers.delete(VAULT_KEY_HEADER)
  headers.delete('X-Linger-Vault-User')
  if (rawKey.length !== 32 || !internalUserId) return
  const encoded = toBase64(rawKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  headers.set(VAULT_KEY_HEADER, encoded)
  headers.set('X-Linger-Vault-User', internalUserId)
}

export function unlockVaultWithKey(internalUserId: string, rawKey: Uint8Array): void {
  if (!internalUserId || rawKey.length !== 32) throw new Error('Invalid recovery key')
  unlockVault(internalUserId, rawKey)
}

export async function encryptVaultValue<T>(internalUserId: string, recordType: string, value: T): Promise<EncryptedVaultValue> {
  const rawKey = getVaultKey(internalUserId)
  if (!rawKey) throw new Error('Unlock the passkey vault first')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, ['encrypt'])
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aadForRecord(internalUserId, recordType)), tagLength: 128 }, key, toArrayBuffer(plaintext))
    return { version: VAULT_VERSION, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }
  } finally { rawKey.fill(0) }
}

export async function decryptVaultValue<T>(internalUserId: string, recordType: string, encrypted: EncryptedVaultValue): Promise<T> {
  if (encrypted.version !== VAULT_VERSION) throw new Error('Unsupported encrypted metadata version')
  const rawKey = getVaultKey(internalUserId)
  if (!rawKey) throw new Error('Unlock the passkey vault first')
  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(fromBase64(encrypted.iv)), additionalData: toArrayBuffer(aadForRecord(internalUserId, recordType)), tagLength: 128 }, key, toArrayBuffer(fromBase64(encrypted.ciphertext)))
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    throw new Error('Encrypted metadata could not be verified')
  } finally { rawKey.fill(0) }
}

export function copyPrfOutput(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value.slice(0))
    : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}
