import { getVaultKey, getVaultUserId, setVaultHeadersForKey, unlockVaultWithKey } from './passkeyVault'
import { broadcastDeviceSessionChanged, requestVaultKeyFromSiblingTab } from './vaultHandoff'

export type RememberDays = 0 | 1 | 7
export type TabSessionRestore = 'restored' | 'missing' | 'unavailable'

const LEGACY_TAB_KEY = 'linger_tab_session_v1'
const LEGACY_DEVICE_KEY = 'linger_device_session_v1'

const DB_NAME = 'linger-device-unlock'
const DB_VERSION = 1
const STORE_NAME = 'sessions'
const RECORD_KEY = 'current'
const DEVICE_UNLOCK_ENDPOINT = '/auth/passkey/device-unlock'
const PASSKEY_SESSION_ENDPOINT = '/auth/passkey/session'
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 60_000

const HKDF_SALT = new TextEncoder().encode('linger/device-unlock/hkdf-salt/v1')
const HKDF_INFO = new TextEncoder().encode('linger/device-unlock/aes-gcm/v1')

interface StoredDeviceUnlock {
  version: 1
  userId: string
  expiresAt: number
  iv: string
  ciphertext: string
}

interface DeviceUnlockServerPayload {
  userId?: unknown
  expiresAt?: unknown
  secret?: unknown
}

let sessionGeneration = 0
let cachedDeviceSession: { userId: string; expiresAt: number } | null = null
let expirationTimer: ReturnType<typeof setTimeout> | undefined

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return fromBase64(padded)
}

function deviceAad(userId: string, expiresAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`linger:v1:device-unlock:${userId}:${expiresAt}`)
}

async function deriveDeviceWrappingKey(secretBytes: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', toArrayBuffer(secretBytes), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(HKDF_SALT), info: toArrayBuffer(HKDF_INFO) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptVaultKeyForDevice(
  rawKey: Uint8Array,
  secretBytes: Uint8Array,
  userId: string,
  expiresAt: number,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrappingKey = await deriveDeviceWrappingKey(secretBytes)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(deviceAad(userId, expiresAt)), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(rawKey),
  ))
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) }
}

async function decryptVaultKeyFromDevice(
  record: StoredDeviceUnlock,
  secretBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = fromBase64(record.iv)
  const ciphertext = fromBase64(record.ciphertext)
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid stored device unlock record')
  const wrappingKey = await deriveDeviceWrappingKey(secretBytes)
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(deviceAad(record.userId, record.expiresAt)), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(ciphertext),
  ))
  if (plaintext.length !== 32) {
    plaintext.fill(0)
    throw new Error('Invalid unwrapped vault key length')
  }
  return plaintext
}

function removeLegacyStorage(): void {
  try { sessionStorage.removeItem(LEGACY_TAB_KEY) } catch { /* Storage may be unavailable. */ }
  try { localStorage.removeItem(LEGACY_DEVICE_KEY) } catch { /* Retry on the next launch. */ }
}

function openDeviceDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        resolve(db)
      }
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function readStoredRecord(): Promise<StoredDeviceUnlock | null> {
  const db = await openDeviceDatabase()
  if (!db) return null
  try {
    return await new Promise<StoredDeviceUnlock | null>(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(RECORD_KEY)
        req.onsuccess = () => resolve((req.result as StoredDeviceUnlock | undefined) ?? null)
        req.onerror = () => resolve(null)
        tx.onabort = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  } finally {
    db.close()
  }
}

async function writeStoredRecord(record: StoredDeviceUnlock): Promise<void> {
  const db = await openDeviceDatabase()
  if (!db) throw new Error('IndexedDB is unavailable in this browser')
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record, RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Failed to save device unlock record'))
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save device unlock record'))
    })
  } finally {
    db.close()
  }
}

async function deleteStoredRecord(): Promise<boolean> {
  const db = await openDeviceDatabase()
  if (!db) return false
  try {
    return await new Promise<boolean>(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        let existed = false
        const getReq = store.get(RECORD_KEY)
        getReq.onsuccess = () => {
          existed = getReq.result !== undefined
          if (existed) store.delete(RECORD_KEY)
        }
        tx.oncomplete = () => resolve(existed)
        tx.onerror = () => resolve(existed)
        tx.onabort = () => resolve(existed)
      } catch {
        resolve(false)
      }
    })
  } finally {
    db.close()
  }
}

function isValidStoredRecord(record: StoredDeviceUnlock | null, now = Date.now()): record is StoredDeviceUnlock {
  if (!record || typeof record !== 'object') return false
  if (record.version !== 1) return false
  if (typeof record.userId !== 'string' || !record.userId) return false
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return false
  if (typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') return false
  return record.expiresAt > now && record.expiresAt <= now + MAX_LIFETIME_MS + CLOCK_SKEW_MS
}

function scheduleExpiry(userId: string, expiresAt: number): void {
  clearTimeout(expirationTimer)
  cachedDeviceSession = { userId, expiresAt }
  const delay = Math.max(0, expiresAt - Date.now())
  expirationTimer = setTimeout(() => {
    if (cachedDeviceSession?.userId === userId && cachedDeviceSession?.expiresAt === expiresAt) {
      void clearTabSession({ clearRemote: true })
    }
  }, delay)
}

function clearMemoryCache(): void {
  clearTimeout(expirationTimer)
  expirationTimer = undefined
  cachedDeviceSession = null
}

async function verifyVaultWithServer(userId: string, rawKey: Uint8Array): Promise<'ok' | 'rejected' | 'unavailable'> {
  try {
    const headers = new Headers()
    setVaultHeadersForKey(headers, userId, rawKey)
    const response = await fetch(PASSKEY_SESSION_ENDPOINT, {
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
    })
    if (response.ok) return 'ok'
    if (response.status === 408 || response.status === 429 || response.status >= 500) return 'unavailable'
    return 'rejected'
  } catch {
    return 'unavailable'
  }
}

function parseServerPayload(data: unknown): { userId: string; expiresAt: number; secretBytes: Uint8Array<ArrayBuffer> } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { userId, expiresAt, secret } = data as DeviceUnlockServerPayload
  if (typeof userId !== 'string' || !userId) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
  if (typeof secret !== 'string' || !secret) return null
  try {
    const secretBytes = decodeBase64Url(secret)
    if (secretBytes.length !== 32) {
      secretBytes.fill(0)
      return null
    }
    return { userId, expiresAt, secretBytes }
  } catch {
    return null
  }
}

export async function clearTabSession(options?: {
  clearRemote?: boolean
  keepCookie?: boolean
  broadcast?: boolean
}): Promise<void> {
  sessionGeneration++
  const hadCached = cachedDeviceSession !== null
  clearMemoryCache()
  removeLegacyStorage()
  const hadIdbRecord = await deleteStoredRecord()
  const hadSession = hadCached || hadIdbRecord
  if (!options?.keepCookie && (options?.clearRemote || hadSession)) {
    await fetch(DEVICE_UNLOCK_ENDPOINT, {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
    }).catch(() => {})
  }
  if (options?.broadcast !== false && (options?.clearRemote || hadSession)) {
    broadcastDeviceSessionChanged()
  }
}

export function getDeviceSessionExpiry(expectedUserId?: string): number | null {
  if (!cachedDeviceSession) return null
  if (expectedUserId !== undefined && cachedDeviceSession.userId !== expectedUserId) return null
  if (cachedDeviceSession.expiresAt <= Date.now()) return null
  return cachedDeviceSession.expiresAt
}

export async function readDeviceSessionExpiry(expectedUserId?: string): Promise<number | null> {
  const record = await readStoredRecord()
  if (!record) {
    if (cachedDeviceSession) clearMemoryCache()
    return null
  }
  if (!isValidStoredRecord(record)) {
    await clearTabSession({ clearRemote: true })
    return null
  }
  scheduleExpiry(record.userId, record.expiresAt)
  if (expectedUserId !== undefined && record.userId !== expectedUserId) return null
  return record.expiresAt
}

export async function enableTabSession(days: 1 | 7 = 7): Promise<number> {
  const userId = getVaultUserId()
  const rawKey = userId ? getVaultKey(userId) : null
  if (!userId || !rawKey) throw new Error('Unlock the passkey vault first')

  const gen = ++sessionGeneration
  let secretBytes: Uint8Array<ArrayBuffer> | null = null
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    setVaultHeadersForKey(headers, userId, rawKey)
    const response = await fetch(DEVICE_UNLOCK_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers,
      body: JSON.stringify({ days }),
    })
    if (!response.ok) throw new Error(`Failed to enable device unlock (${response.status})`)

    const payload = parseServerPayload(await response.json())
    if (!payload || payload.userId !== userId) {
      payload?.secretBytes.fill(0)
      throw new Error('Invalid device unlock response')
    }
    secretBytes = payload.secretBytes

    const { iv, ciphertext } = await encryptVaultKeyForDevice(rawKey, secretBytes, userId, payload.expiresAt)
    if (gen !== sessionGeneration || getVaultUserId() !== userId) {
      await fetch(DEVICE_UNLOCK_ENDPOINT, { method: 'DELETE', credentials: 'include', cache: 'no-store', redirect: 'error' }).catch(() => {})
      throw new DOMException('Device session cancelled', 'AbortError')
    }

    await writeStoredRecord({
      version: 1,
      userId,
      expiresAt: payload.expiresAt,
      iv,
      ciphertext,
    })

    if (gen !== sessionGeneration || getVaultUserId() !== userId) {
      await deleteStoredRecord()
      await fetch(DEVICE_UNLOCK_ENDPOINT, { method: 'DELETE', credentials: 'include', cache: 'no-store', redirect: 'error' }).catch(() => {})
      throw new DOMException('Device session cancelled', 'AbortError')
    }

    scheduleExpiry(userId, payload.expiresAt)
    broadcastDeviceSessionChanged()
    return payload.expiresAt
  } finally {
    rawKey.fill(0)
    secretBytes?.fill(0)
  }
}

export function saveTabSession(): void {
  // No-op: Split-Key persistence writes explicitly on enableTabSession().
}

export async function restoreTabSession(isCurrent: () => boolean = () => true): Promise<TabSessionRestore> {
  removeLegacyStorage()
  if (getVaultUserId()) return 'missing'
  const gen = sessionGeneration

  // 1. Try Split-Key device unlock (IndexedDB encrypted blob + HttpOnly cookie secret).
  const record = await readStoredRecord()
  if (record) {
    if (!isValidStoredRecord(record)) {
      await clearTabSession({ clearRemote: true })
    } else {
      let response: Response
      try {
        response = await fetch(DEVICE_UNLOCK_ENDPOINT, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
        })
      } catch {
        return 'unavailable'
      }

      if (!isCurrent() || gen !== sessionGeneration) return 'missing'
      if (response.status === 408 || response.status === 429 || response.status >= 500) return 'unavailable'

      if (!response.ok) {
        await clearTabSession({ keepCookie: true })
      } else {
        let payload: { userId: string; expiresAt: number; secretBytes: Uint8Array<ArrayBuffer> } | null = null
        let rawKey: Uint8Array<ArrayBuffer> | null = null
        try {
          payload = parseServerPayload(await response.json().catch(() => null))
          if (!payload || payload.userId !== record.userId || payload.expiresAt !== record.expiresAt) {
            await clearTabSession({ clearRemote: true })
          } else {
            rawKey = await decryptVaultKeyFromDevice(record, payload.secretBytes)
            const check = await verifyVaultWithServer(record.userId, rawKey)
            if (check === 'unavailable') return 'unavailable'
            if (check === 'rejected') {
              await clearTabSession({ clearRemote: true })
            } else {
              if (!isCurrent() || gen !== sessionGeneration) return 'missing'
              unlockVaultWithKey(record.userId, rawKey)
              scheduleExpiry(record.userId, record.expiresAt)
              return 'restored'
            }
          }
        } catch {
          await clearTabSession({ clearRemote: true })
        } finally {
          payload?.secretBytes.fill(0)
          rawKey?.fill(0)
        }
      }
    }
  }

  // 2. Fall back to in-memory handoff from an already-unlocked sibling tab.
  if (!isCurrent() || gen !== sessionGeneration) return 'missing'
  const handoff = await requestVaultKeyFromSiblingTab()
  if (handoff) {
    try {
      if (!isCurrent() || gen !== sessionGeneration) return 'missing'
      const check = await verifyVaultWithServer(handoff.userId, handoff.key)
      if (check === 'unavailable') return 'unavailable'
      if (check === 'ok') {
        if (!isCurrent() || gen !== sessionGeneration) return 'missing'
        unlockVaultWithKey(handoff.userId, handoff.key)
        return 'restored'
      }
    } finally {
      handoff.key.fill(0)
    }
  }

  return 'missing'
}
