import { decryptLocalData, encryptLocalData, localDataLookupKey } from './localDataCrypto'
import type { LocalDataEnvelope } from './localDataCrypto'
import { getVaultRevision, getVaultUserId } from './passkeyVault'
import { getDiaryDatabase } from './diaryCache'
import type { DraftEntry } from './diaryCache'
import type { CachedEntry } from './diaryCache'

interface StoredRecord {
  key: string
  group: string
  ownerHash?: string
  revision: string
  envelope: LocalDataEnvelope
}

export interface LocalRecord<T> { value: T; revision: string }

const STORE = 'secureRecords'
const MARKERS = 'draftKeyMarkers'
const openDatabase = getDiaryDatabase

/** Indicates that existing drafts belong to a different or unavailable vault key. */
export class DraftKeyMismatchError extends Error {
  constructor() { super('The saved drafts cannot be opened with this passkey'); this.name = 'DraftKeyMismatchError' }
}

export class LocalWriteConflictError extends Error {
  constructor() { super('Local data changed during write'); this.name = 'LocalWriteConflictError' }
}

interface DraftKeyMarker { ownerHash: string; userId: string; group: string; revision: string; envelope: LocalDataEnvelope }
export interface DraftKeyGuard { ownerHash: string; revision: string }

async function draftOwnerHash(owner: string): Promise<string> {
  const normalized = owner.trim().toLowerCase()
  if (!normalized) throw new Error('A verified draft owner is required')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`linger-draft-owner-v1:${normalized}`))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Claim or verify the key for an authenticated Google account. The owner hash is
 * deliberately independent of the vault key so a new vault cannot mistake old
 * encrypted drafts for an empty collection. It is a hash, not anonymization.
 */
export async function verifyDraftKey(owner: string, userId: string, assertContext?: () => void): Promise<DraftKeyGuard> {
  assertContext?.()
  const vaultRevision = getVaultRevision()
  const ownerHash = await draftOwnerHash(owner)
  const group = await localDataLookupKey(userId, 'group', 'draft')
  const db = await openDatabase()
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  let marker = await requestResult(db.transaction(MARKERS, 'readonly').objectStore(MARKERS).get(ownerHash)) as DraftKeyMarker | undefined
  if (!marker) {
    const revision = crypto.randomUUID()
    const envelope = await encryptLocalData(userId, 'draft-key-marker', ownerHash, { purpose: 'linger-draft-key-v1', group, revision })
    if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
    const candidate: DraftKeyMarker = { ownerHash, userId, group, revision, envelope }
    marker = await new Promise<DraftKeyMarker>((resolve, reject) => {
      const tx = db.transaction(MARKERS, 'readwrite')
      const store = tx.objectStore(MARKERS)
      let selected: DraftKeyMarker | undefined
      let failure: unknown
      const read = store.get(ownerHash)
      read.onsuccess = () => {
        if (!active(userId, vaultRevision)) { tx.abort(); return }
        try { assertContext?.() } catch (error) { failure = error; tx.abort(); return }
        selected = read.result as DraftKeyMarker | undefined
        if (!selected) {
          try { store.add(candidate); selected = candidate } catch (error) { failure = error; tx.abort() }
        }
      }
      tx.oncomplete = () => selected ? resolve(selected) : reject(new Error('Draft key marker missing'))
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Draft key marker transaction aborted'))
      tx.onerror = () => { /* Report the transaction failure on abort. */ }
    })
  }
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  let matches = marker.userId === userId
  try {
    if (matches) {
      const value = await decryptLocalData<{ purpose: string; group: string; revision: string }>(userId, 'draft-key-marker', ownerHash, marker.envelope)
      matches = value.purpose === 'linger-draft-key-v1' && value.group === marker.group && value.revision === marker.revision && group === marker.group
    }
  } catch (error) {
    if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation', { cause: error })
    matches = false
  }
  if (!matches) {
    if (marker.userId === userId) throw new DraftKeyMismatchError()
    // A lost passkey must not permanently block an account that has no saved
    // drafts. Never replace a marker while its old encrypted group has records.
    if (typeof marker.group !== 'string') throw new DraftKeyMismatchError()
    const revision = crypto.randomUUID()
    const envelope = await encryptLocalData(userId, 'draft-key-marker', ownerHash, { purpose: 'linger-draft-key-v1', group, revision })
    const previous = marker
    const replaced = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([MARKERS, STORE], 'readwrite')
      const markers = tx.objectStore(MARKERS)
      const read = markers.get(ownerHash)
      const records = tx.objectStore(STORE)
      const count = records.index('group').count(previous.group)
      const ownerCount = records.index('owner').count(ownerHash)
      let ready = 0
      let success = false
      let failure: unknown
      const check = () => {
        if (++ready !== 3) return
        if (!active(userId, vaultRevision)) { tx.abort(); return }
        try { assertContext?.() } catch (error) { failure = error; tx.abort(); return }
        if (JSON.stringify(read.result) !== JSON.stringify(previous) || count.result !== 0 || ownerCount.result !== 0) return
        const replacement: DraftKeyMarker = { ownerHash, userId, group, revision, envelope }
        try { markers.put(replacement); marker = replacement; success = true }
        catch (error) { failure = error; tx.abort() }
      }
      read.onsuccess = check
      count.onsuccess = check
      ownerCount.onsuccess = check
      tx.oncomplete = () => resolve(success)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Draft key marker transaction aborted'))
      tx.onerror = () => { /* Report the transaction failure on abort. */ }
    })
    if (!replaced) throw new DraftKeyMismatchError()
  }
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  assertContext?.()
  return { ownerHash, revision: marker.revision }
}

/** Atomically replace an unchanged legacy draft with its encrypted copy. */
export async function migrateEncryptedDraft(userId: string, draft: DraftEntry, guard?: DraftKeyGuard, assertContext?: () => void): Promise<boolean> {
  if (!draft.owner) throw new Error('A verified draft owner is required')
  const vaultRevision = getVaultRevision()
  const kind = 'draft'
  const key = await localDataLookupKey(userId, kind, draft.date)
  const group = await localDataLookupKey(userId, 'group', kind)
  const existing = await readEncryptedLocal<DraftEntry>(userId, kind, draft.date)
  if (existing && JSON.stringify(existing.value) !== JSON.stringify(draft)) {
    throw new Error('Encrypted and legacy drafts differ; manual recovery is required')
  }
  const envelope = existing ? null : await encryptLocalData(userId, kind, key, draft)
  const db = await openDatabase()
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  const legacyKey = `${draft.owner}\u0000${draft.date}`
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(guard ? ['accountDrafts', 'drafts', STORE, MARKERS] : ['accountDrafts', 'drafts', STORE], 'readwrite')
    const legacy = tx.objectStore('accountDrafts')
    const olderLegacy = tx.objectStore('drafts')
    const secure = tx.objectStore(STORE)
    const legacyRead = legacy.get(legacyKey)
    const olderRead = olderLegacy.get(draft.date)
    const secureRead = secure.get(key)
    const markerRead = guard ? tx.objectStore(MARKERS).get(guard.ownerHash) : null
    let migrated = false
    let failure: unknown
    let checked = false
    let ready = 0
    const check = () => {
      if (++ready !== (markerRead ? 4 : 3) || checked) return
      checked = true
      if (!active(userId, vaultRevision)) { tx.abort(); return }
      try { assertContext?.() } catch (error) { failure = error; tx.abort(); return }
      if (guard && markerRead?.result?.revision !== guard.revision) { tx.abort(); return }
      const source = legacyRead.result as (DraftEntry & { key: string }) | undefined
      if (!source) return
      const { key: _key, ...current } = source
      if (JSON.stringify(current) !== JSON.stringify(draft)) return
      const currentSecure = secureRead.result as StoredRecord | undefined
      if ((currentSecure?.revision ?? null) !== (existing?.revision ?? null)) return
      try {
        if (!currentSecure && envelope) secure.add({ key, group, ownerHash: guard?.ownerHash, revision: crypto.randomUUID(), envelope } satisfies StoredRecord)
        legacy.delete(legacyKey)
        // Version 2 drafts were copied into accountDrafts without removing the
        // original. Only remove a byte-for-byte equivalent copy; a divergent or
        // ownerless record may be the only recovery copy and must remain.
        if (JSON.stringify(olderRead.result) === JSON.stringify(draft)) olderLegacy.delete(draft.date)
        migrated = true
      } catch (error) { failure = error; tx.abort() }
    }
    legacyRead.onsuccess = check
    olderRead.onsuccess = check
    secureRead.onsuccess = check
    if (markerRead) markerRead.onsuccess = check
    tx.oncomplete = () => resolve(migrated)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Draft migration aborted'))
    tx.onerror = () => { /* onabort reports the transaction failure. */ }
  })
}

function active(userId: string, revision: number): boolean {
  return getVaultUserId() === userId && getVaultRevision() === revision
}

/** Move a verified cache record in one IndexedDB transaction. */
export async function migrateEncryptedCache(userId: string, entry: CachedEntry, guard: DraftKeyGuard, assertContext: () => void, recovered: CachedEntry = entry): Promise<boolean> {
  const vaultRevision = getVaultRevision()
  const kind = `diary-cache:${guard.ownerHash}`
  const key = await localDataLookupKey(userId, kind, entry.date)
  const group = await localDataLookupKey(userId, 'group', kind)
  const existing = await readEncryptedLocal<CachedEntry>(userId, kind, entry.date)
  const envelope = existing ? null : await encryptLocalData(userId, kind, key, recovered)
  const db = await openDatabase()
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(['entries', STORE, MARKERS], 'readwrite')
    const legacy = tx.objectStore('entries')
    const secure = tx.objectStore(STORE)
    const old = legacy.get(entry.date)
    const current = secure.get(key)
    const marker = tx.objectStore(MARKERS).get(guard.ownerHash)
    let count = 0
    let migrated = false
    let failure: unknown
    const check = () => {
      if (++count !== 3) return
      try { assertContext() } catch (error) { failure = error; tx.abort(); return }
      if (!active(userId, vaultRevision) || marker.result?.revision !== guard.revision) { tx.abort(); return }
      if (JSON.stringify(old.result) !== JSON.stringify(entry) || (current.result?.revision ?? null) !== (existing?.revision ?? null)) return
      // A newer encrypted cache can replace an old cache, but the old row is
      // kept if its contents differ, because it may contain the only copy.
      if (existing && JSON.stringify(existing.value) !== JSON.stringify(recovered)) return
      try {
        if (envelope) secure.add({ key, group, ownerHash: guard.ownerHash, revision: crypto.randomUUID(), envelope } satisfies StoredRecord)
        legacy.delete(entry.date)
        migrated = true
      } catch (error) { failure = error; tx.abort() }
    }
    old.onsuccess = check
    current.onsuccess = check
    marker.onsuccess = check
    tx.oncomplete = () => resolve(migrated)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Cache migration aborted'))
    tx.onerror = () => {}
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** `revision` is null for an absent record; writes reject on concurrent changes. */
export async function readEncryptedLocal<T>(userId: string, kind: string, id: string): Promise<LocalRecord<T> | null> {
  const vaultRevision = getVaultRevision()
  const key = await localDataLookupKey(userId, kind, id)
  const db = await openDatabase()
  const row = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(key)) as StoredRecord | undefined
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  if (!row) return null
  const value = await decryptLocalData<T>(userId, kind, key, row.envelope)
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  return { value, revision: row.revision }
}

/** Enumerate records within one unlocked account and data type. */
export async function listEncryptedLocal<T>(userId: string, kind: string): Promise<LocalRecord<T>[]> {
  const vaultRevision = getVaultRevision()
  const group = await localDataLookupKey(userId, 'group', kind)
  const db = await openDatabase()
  const rows = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).index('group').getAll(group)) as StoredRecord[]
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  const result = await Promise.all(rows.map(async row => ({
    value: await decryptLocalData<T>(userId, kind, row.key, row.envelope),
    revision: row.revision,
  })))
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  return result
}

export async function writeEncryptedLocal<T>(userId: string, kind: string, id: string, value: T, expectedRevision: string | null, guard?: DraftKeyGuard, assertContext?: () => void): Promise<string> {
  const vaultRevision = getVaultRevision()
  const key = await localDataLookupKey(userId, kind, id)
  const group = await localDataLookupKey(userId, 'group', kind)
  const envelope = await encryptLocalData(userId, kind, key, value)
  const db = await openDatabase()
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  const revision = crypto.randomUUID()
  return new Promise<string>((resolve, reject) => {
    const tx = db.transaction(guard ? [STORE, MARKERS] : [STORE], 'readwrite')
    const store = tx.objectStore(STORE)
    let conflict = false
    let failure: unknown
    const existing = store.get(key)
    const marker = guard ? tx.objectStore(MARKERS).get(guard.ownerHash) : null
    let ready = 0
    const check = () => {
      if (++ready !== (marker ? 2 : 1)) return
      try { assertContext?.() } catch (error) { failure = error; tx.abort(); return }
      if (!active(userId, vaultRevision) || (existing.result?.revision ?? null) !== expectedRevision || (guard && marker?.result?.revision !== guard.revision)) {
        conflict = true
        tx.abort()
        return
      }
      try { store.put({ key, group, ownerHash: guard?.ownerHash, revision, envelope } satisfies StoredRecord) }
      catch (error) { failure = error; tx.abort() }
    }
    existing.onsuccess = check
    if (marker) marker.onsuccess = check
    tx.oncomplete = () => resolve(revision)
    tx.onabort = () => reject(conflict ? new LocalWriteConflictError() : failure ?? tx.error ?? new Error('Local data write aborted'))
    tx.onerror = () => { /* onabort reports the transaction failure. */ }
  })
}

export async function deleteEncryptedLocal(userId: string, kind: string, id: string, expectedRevision: string, guard?: DraftKeyGuard, assertContext?: () => void): Promise<boolean> {
  const vaultRevision = getVaultRevision()
  const key = await localDataLookupKey(userId, kind, id)
  const db = await openDatabase()
  if (!active(userId, vaultRevision)) throw new Error('Passkey vault changed during local data operation')
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(guard ? [STORE, MARKERS] : [STORE], 'readwrite')
    const store = tx.objectStore(STORE)
    let deleted = false
    let locked = false
    let failure: unknown
    const existing = store.get(key)
    const marker = guard ? tx.objectStore(MARKERS).get(guard.ownerHash) : null
    let ready = 0
    const check = () => {
      if (++ready !== (marker ? 2 : 1)) return
      try { assertContext?.() } catch (error) { failure = error; tx.abort(); return }
      if (!active(userId, vaultRevision) || (guard && marker?.result?.revision !== guard.revision)) { locked = true; tx.abort(); return }
      if (existing.result?.revision === expectedRevision) {
        try { store.delete(key); deleted = true } catch (error) { failure = error; tx.abort() }
      }
    }
    existing.onsuccess = check
    if (marker) marker.onsuccess = check
    tx.oncomplete = () => resolve(deleted)
    tx.onabort = () => reject(locked ? new Error('Passkey vault changed during local data operation') : failure ?? tx.error ?? new Error('Local data deletion aborted'))
    tx.onerror = () => { /* onabort reports the transaction failure. */ }
  })
}
