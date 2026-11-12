import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveAccount } from '../../src/lib/accountSession'
import { clearVaultKey, unlockVaultWithKey } from '../../src/lib/passkeyVault'
import { getDiaryDatabase, putCached as putLegacyCached } from '../../src/lib/diaryCache'
import { getAllCached, hasLegacyCache, putCached, recoverLegacyCache } from '../../src/lib/secureCache'
import { LocalStorageAdapter } from '../../src/lib/storageAdapter'
import { SyncQueueManager } from '../../src/lib/syncQueue'
import { SecureLocalData } from '../../src/lib/secureLocalData'

let email: string
let userId: string
beforeEach(() => {
  email = `${crypto.randomUUID()}@example.com`
  userId = crypto.randomUUID()
  localStorage.clear()
  setActiveAccount(`email:${email}`, false, email)
  unlockVaultWithKey(userId, new Uint8Array(32).fill(12))
})
afterEach(() => { localStorage.clear(); clearVaultKey(); setActiveAccount(null); vi.restoreAllMocks() })

async function allSecureRecords(): Promise<string> {
  const db = await getDiaryDatabase()
  return new Promise((resolve, reject) => {
    const req = db.transaction('secureRecords').objectStore('secureRecords').getAll()
    req.onsuccess = () => resolve(JSON.stringify(req.result))
    req.onerror = () => reject(req.error)
  })
}

describe('encrypted application data', () => {
  it('stores cache, mirror and queued operations without plaintext identifiers or contents', async () => {
    const date = '2035-03-15'
    const content = `private-${crypto.randomUUID()}`
    const entry = { owner: email, date, meta: { id: 'secret-file', name: 'secret-name', version: '1' }, content: { date, content } }
    await putCached(entry)
    await new LocalStorageAdapter().saveEntry(date, content)
    await new SyncQueueManager(email).enqueue({ id: 'private-op', type: 'SAVE', date, content, timestamp: 5 })
    expect(await getAllCached()).toContainEqual(entry)
    expect((await new LocalStorageAdapter().getEntry(date))?.entry.content).toBe(content)
    expect((await new SyncQueueManager(email).getPending())[0].content).toBe(content)
    const stored = await allSecureRecords()
    for (const secret of [content, date, email, 'private-op', 'secret-file']) expect(stored).not.toContain(secret)
    expect(JSON.stringify(localStorage)).not.toContain(content)
  })

  it('keeps another vault from treating non-draft encrypted records as an empty account', async () => {
    await new SecureLocalData<string>('milestones').update('list', () => 'private')
    unlockVaultWithKey('replacement-vault', new Uint8Array(32).fill(42))
    await expect(new SecureLocalData<string>('milestones').get('list')).rejects.toThrow('cannot be opened')
    unlockVaultWithKey(userId, new Uint8Array(32).fill(12))
    expect(await new SecureLocalData<string>('milestones').get('list')).toBe('private')
  })

  it('isolates Google accounts even when they share the same unlocked vault', async () => {
    const firstOwner = email
    const first = new SecureLocalData<string>('milestones')
    await first.update('list', () => 'first account only')
    const firstQueue = new SyncQueueManager(firstOwner)
    await firstQueue.enqueue({ id: 'same-id', type: 'SAVE', date: '2030-01-01', content: 'first private', timestamp: 1 })
    await putCached({ owner: firstOwner, date: '2030-01-01', meta: { id: 'first', name: 'n', version: '1' } })
    await new LocalStorageAdapter().saveEntry('2030-01-01', 'first mirror')
    const secondOwner = `${crypto.randomUUID()}@example.com`
    setActiveAccount(`email:${secondOwner}`, false, secondOwner)
    expect(await new SecureLocalData<string>('milestones').get('list')).toBeNull()
    expect(await new SyncQueueManager(secondOwner).getPending()).toEqual([])
    expect(await getAllCached()).toEqual([])
    expect(await new LocalStorageAdapter().getEntry('2030-01-01')).toBeNull()
    await new SecureLocalData<string>('milestones').update('list', () => 'second account only')
    await new SyncQueueManager(secondOwner).enqueue({ id: 'same-id', type: 'SAVE', date: '2030-01-01', content: 'second private', timestamp: 1 })
    setActiveAccount(`email:${firstOwner}`, false, firstOwner)
    expect(await first.get('list')).toBe('first account only')
    expect((await firstQueue.getPending())[0].content).toBe('first private')
  })

  it('atomically migrates account-owned cache while retaining unattributed cache', async () => {
    const own = { owner: email, date: '2030-01-01', meta: { id: 'id', name: 'n', version: '1' }, content: { date: '2030-01-01', content: 'legacy secret' } }
    const unknown = { date: '2030-01-02', meta: { id: 'other', name: 'n', version: '1' } }
    await putLegacyCached(own)
    await putLegacyCached(unknown)
    expect(await getAllCached()).toContainEqual(own)
    const { getAllCached: legacy } = await import('../../src/lib/diaryCache')
    expect(await legacy()).toContainEqual(unknown)
    expect(await legacy()).not.toContainEqual(own)
    expect(await hasLegacyCache()).toBe(true)
    await recoverLegacyCache()
    expect(await legacy()).not.toContainEqual(unknown)
    expect(await getAllCached()).toContainEqual({ ...unknown, owner: email })
  })

  it('migrates scoped queue and mirror only after encrypted storage succeeds', async () => {
    localStorage.setItem('linger_session_user', email)
    localStorage.setItem('linger_local_entry_2030-01-01', JSON.stringify({ content: 'old mirror', version: '1' }))
    const queueItem = { id: 'q1', type: 'REMOVE', date: '2030-01-01', timestamp: 1 }
    const queueKey = `linger_pending_sync_item:${encodeURIComponent(email)}:q1`
    localStorage.setItem(queueKey, JSON.stringify(queueItem))
    await new LocalStorageAdapter().recoverLegacy()
    expect((await new LocalStorageAdapter().getEntry('2030-01-01'))?.entry.content).toBe('old mirror')
    expect(await new SyncQueueManager(email).getPending()).toEqual([queueItem])
    expect(localStorage.getItem('linger_local_entry_2030-01-01')).toBeNull()
    expect(localStorage.getItem(queueKey)).toBeNull()
    expect(await allSecureRecords()).not.toContain('old mirror')
  })

  it('leaves another account’s legacy mirror untouched', async () => {
    localStorage.setItem('linger_local_mirror_legacy_owner', 'other@example.com')
    localStorage.setItem('linger_session_user', email)
    localStorage.setItem('linger_local_entry_2030-01-01', 'other account')
    expect(await new LocalStorageAdapter().getEntry('2030-01-01')).toBeNull()
    expect(localStorage.getItem('linger_local_entry_2030-01-01')).toBe('other account')
  })

  it('keeps plaintext queue when encrypted storage fails', async () => {
    localStorage.setItem('linger_session_user', email)
    const item = { id: 'q1', type: 'REMOVE', date: '2030-01-01', timestamp: 1 }
    const key = `linger_pending_sync_item:${encodeURIComponent(email)}:q1`
    localStorage.setItem(key, JSON.stringify(item))
    clearVaultKey()
    await expect(new SyncQueueManager(email).getPending()).rejects.toThrow()
    expect(localStorage.getItem(key)).toBe(JSON.stringify(item))
  })
})
