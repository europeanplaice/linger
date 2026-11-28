import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTabSession, enableTabSession, getDeviceSessionExpiry, readDeviceSessionExpiry, restoreTabSession } from '../../src/lib/tabSession'
import { clearVaultKey, getVaultKey, getVaultUserId, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { broadcastVaultLock, subscribeVaultHandoff } from '../../src/lib/vaultHandoff'

const DAY_MS = 24 * 60 * 60 * 1000

const channels = new Set<MockBroadcastChannel>()

class MockBroadcastChannel {
  listeners: Array<(e: { data: unknown }) => void> = []
  constructor(public name: string) { channels.add(this) }
  postMessage(data: unknown) {
    for (const ch of channels) {
      if (ch !== this && ch.name === this.name) {
        // Structured-clone Uint8Array payloads so sender zeroing does not erase receiver bytes.
        const cloned = data && typeof data === 'object' && 'key' in data && (data as { key?: unknown }).key instanceof Uint8Array
          ? { ...data, key: new Uint8Array((data as { key: Uint8Array }).key) }
          : data
        queueMicrotask(() => ch.listeners.forEach(listener => listener({ data: cloned })))
      }
    }
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (type === 'message') this.listeners.push(listener)
  }
  removeEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (type === 'message') this.listeners = this.listeners.filter(l => l !== listener)
  }
  close() { channels.delete(this) }
}

async function readIdbRecord(): Promise<{ version: number; userId: string; expiresAt: number; iv: string; ciphertext: string } | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('linger-device-unlock', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('sessions')) req.result.createObjectStore('sessions')
    }
    req.onsuccess = () => {
      const db = req.result
      const getReq = db.transaction('sessions', 'readonly').objectStore('sessions').get('current')
      getReq.onsuccess = () => { db.close(); resolve(getReq.result) }
      getReq.onerror = () => { db.close(); reject(getReq.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

async function writeIdbRecord(record: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('linger-device-unlock', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('sessions')) req.result.createObjectStore('sessions')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put(record, 'current')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  channels.clear()
})

afterEach(async () => {
  await clearTabSession()
  clearVaultKey()
  channels.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('split-key device unlock and cross-tab handoff', () => {
  it('removes legacy saved keys without unlocking or contacting the server', async () => {
    localStorage.setItem('linger_device_session_v1', JSON.stringify({ userId: 'old', key: 'secret' }))
    sessionStorage.setItem('linger_tab_session_v1', JSON.stringify({ userId: 'old', key: 'secret' }))
    localStorage.setItem('unrelated-draft', 'keep')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await restoreTabSession()).toBe('missing')
    expect(getVaultUserId()).toBeNull()
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
    expect(sessionStorage.getItem('linger_tab_session_v1')).toBeNull()
    expect(localStorage.getItem('unrelated-draft')).toBe('keep')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips device and sibling-tab restoration when the vault is already unlocked in memory', async () => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    const siblingListener = vi.fn()
    const sibling = new MockBroadcastChannel('linger_vault_handoff')
    sibling.addEventListener('message', siblingListener)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    unlockVaultWithKey('already-unlocked', new Uint8Array(32).fill(3))
    expect(await restoreTabSession()).toBe('missing')
    expect(getVaultUserId()).toBe('already-unlocked')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(siblingListener).not.toHaveBeenCalled()

    sibling.close()
  })

  it('encrypts the vault key in IndexedDB with the server-issued secret and restores on reload', async () => {
    const userId = 'vault-user-1'
    const rawKey = new Uint8Array(32).map((_, i) => i + 1)
    const secret = encodeBase64Url(new Uint8Array(32).fill(9))
    const expiresAt = Date.now() + 7 * DAY_MS

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/passkey/device-unlock' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ days: 7 })
        return new Response(JSON.stringify({ userId, expiresAt, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ userId, expiresAt, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/session') {
        const headers = init?.headers as Headers
        expect(headers.get('X-Linger-Vault-User')).toBe(userId)
        expect(headers.get('X-Linger-Vault-Key')).toBe(encodeBase64Url(rawKey))
        return new Response(JSON.stringify({ valid: true }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    unlockVaultWithKey(userId, rawKey)
    const savedExpiry = await enableTabSession(7)
    expect(savedExpiry).toBe(expiresAt)
    expect(getDeviceSessionExpiry(userId)).toBe(expiresAt)

    const idbRecord = await readIdbRecord()
    expect(idbRecord).toMatchObject({ version: 1, userId, expiresAt })
    expect(JSON.stringify(idbRecord)).not.toContain(encodeBase64Url(rawKey))
    expect(JSON.stringify(idbRecord)).not.toContain(secret)
    expect(localStorage.getItem('linger_device_session_v1')).toBeNull()
    expect(sessionStorage.getItem('linger_tab_session_v1')).toBeNull()

    // Simulate reload: clear in-memory key and restore via Split-Key
    clearVaultKey()
    expect(getVaultUserId()).toBeNull()

    expect(await restoreTabSession()).toBe('restored')
    expect(getVaultUserId()).toBe(userId)
    const restoredKey = getVaultKey(userId)
    expect(restoredKey).toEqual(rawKey)
    restoredKey?.fill(0)
  })

  it('rejects a tampered IndexedDB record whose expiresAt or userId fails AAD verification', async () => {
    const userId = 'vault-user-1'
    const rawKey = new Uint8Array(32).fill(5)
    const secret = encodeBase64Url(new Uint8Array(32).fill(11))
    const expiresAt = Date.now() + DAY_MS

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/passkey/device-unlock' && init?.method === 'POST') {
        return new Response(JSON.stringify({ userId, expiresAt, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ userId, expiresAt: expiresAt + 5000, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    unlockVaultWithKey(userId, rawKey)
    await enableTabSession(1)
    const record = await readIdbRecord()
    await writeIdbRecord({ ...record!, expiresAt: expiresAt + 5000 })

    clearVaultKey()
    expect(await restoreTabSession()).toBe('missing')
    expect(getVaultUserId()).toBeNull()
    expect(await readIdbRecord()).toBeUndefined()
  })

  it('cleans up an expired local record without calling GET device-unlock', async () => {
    const expiresAt = Date.now() - 1000
    await writeIdbRecord({
      version: 1,
      userId: 'expired-user',
      expiresAt,
      iv: btoa('123456789012'),
      ciphertext: btoa('12345678901234567890'),
    })
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    expect(await restoreTabSession()).toBe('missing')
    expect(await readIdbRecord()).toBeUndefined()
    expect(await readDeviceSessionExpiry('expired-user')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/auth/passkey/device-unlock', expect.objectContaining({ method: 'DELETE' }))
  })

  it('clears the local record on 401 and preserves it on 503/network outage', async () => {
    const userId = 'vault-user-2'
    const rawKey = new Uint8Array(32).fill(8)
    const secret = encodeBase64Url(new Uint8Array(32).fill(14))
    const expiresAt = Date.now() + DAY_MS

    let mode: '503' | '401' = '503'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/passkey/device-unlock' && init?.method === 'POST') {
        return new Response(JSON.stringify({ userId, expiresAt, secret }), { status: 200 })
      }
      if (url === '/auth/passkey/device-unlock' && (!init?.method || init.method === 'GET')) {
        return new Response('{}', { status: mode === '503' ? 503 : 401 })
      }
      if (url === '/auth/passkey/device-unlock' && init?.method === 'DELETE') {
        return new Response('{}', { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    unlockVaultWithKey(userId, rawKey)
    await enableTabSession(1)
    clearVaultKey()

    expect(await restoreTabSession()).toBe('unavailable')
    expect(await readIdbRecord()).toBeDefined()

    mode = '401'
    expect(await restoreTabSession()).toBe('missing')
    expect(await readIdbRecord()).toBeUndefined()
  })

  it('shares the in-memory vault key across open tabs via BroadcastChannel after server verification', async () => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    const userId = 'sibling-user'
    const rawKey = new Uint8Array(32).map((_, i) => 200 - i)
    const sibling = new MockBroadcastChannel('linger_vault_handoff')
    sibling.addEventListener('message', event => {
      const msg = event.data as { type?: string; requestId?: string }
      if (msg.type === 'VAULT_KEY_REQUEST' && msg.requestId) {
        sibling.postMessage({ type: 'VAULT_KEY_RESPONSE', requestId: msg.requestId, userId, key: rawKey })
      }
    })

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/passkey/session') {
        const headers = init?.headers as Headers
        if (headers.get('X-Linger-Vault-User') === userId && headers.get('X-Linger-Vault-Key') === encodeBase64Url(rawKey)) {
          return new Response(JSON.stringify({ valid: true }), { status: 200 })
        }
        return new Response('{}', { status: 401 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await restoreTabSession()).toBe('restored')
    expect(getVaultUserId()).toBe(userId)
    expect(getVaultKey(userId)).toEqual(rawKey)

    // Sibling tab rejects invalid session check
    clearVaultKey()
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect(await restoreTabSession()).toBe('missing')
    expect(getVaultUserId()).toBeNull()

    // Sibling lock broadcast triggers onLocked handler
    const onLocked = vi.fn()
    const unsubscribe = subscribeVaultHandoff({ onLocked })
    broadcastVaultLock()
    await Promise.resolve()
    expect(onLocked).toHaveBeenCalledOnce()

    unsubscribe()
    sibling.close()
  })
})
