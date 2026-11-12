import type { DiaryEntry, DriveFileMeta } from '../types'

const DB_NAME = 'linger_diary_cache'
const DB_VERSION = 5
const STORE = 'entries'
const DRAFTS_STORE = 'drafts'
const ACCOUNT_DRAFTS_STORE = 'accountDrafts'

export interface CachedEntry {
  owner?: string
  date: string
  meta: DriveFileMeta
  content?: DiaryEntry
  snippet?: string
}

// An edit that could not reach Drive (typically because the device was
// offline). baseVersion/baseContent capture the entry state the edit was made
// against, so a later sync still goes through normal conflict detection.
export interface DraftEntry {
  owner?: string
  date: string
  content: string
  baseVersion: string | null
  baseContent: string | null
  savedAt: number
  // Set when a background sync hit a conflict; the draft is then left for the
  // user to resolve in the editor instead of being retried automatically.
  conflicted?: boolean
}

function draftKey(owner: string | undefined, date: string): string {
  return `${owner ?? '__unscoped_test__'}\u0000${date}`
}

let _db: Promise<IDBDatabase> | null = null
let _secureDb: Promise<IDBDatabase> | null = null
let localUpgradeInProgress = false
type DatabaseNotice = 'confirm-upgrade' | 'blocked' | 'versionchange' | null
let databaseNotice: DatabaseNotice = null
const noticeListeners = new Set<() => void>()
let resolveUpgradeConfirmation: (() => void) | null = null

export function getDatabaseNotice(): DatabaseNotice { return databaseNotice }
export function subscribeDatabaseNotice(listener: () => void): () => void {
  noticeListeners.add(listener)
  return () => { noticeListeners.delete(listener) }
}
export function confirmLegacyUpgrade(): void {
  const resolve = resolveUpgradeConfirmation
  if (!resolve) return
  resolveUpgradeConfirmation = null
  setDatabaseNotice(null)
  resolve()
}
function setDatabaseNotice(notice: DatabaseNotice): void {
  if (databaseNotice === notice) return
  databaseNotice = notice
  noticeListeners.forEach(listener => listener())
}

function openDB(version: number | undefined, slot: 'cache' | 'secure' | 'probe'): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'date' })
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE, { keyPath: 'date' })
      if (!db.objectStoreNames.contains(ACCOUNT_DRAFTS_STORE)) {
        const drafts = db.createObjectStore(ACCOUNT_DRAFTS_STORE, { keyPath: 'key' })
        if (db.objectStoreNames.contains(DRAFTS_STORE)) {
          const old = req.transaction!.objectStore(DRAFTS_STORE)
          const cursor = old.openCursor()
          cursor.onsuccess = () => {
            const current = cursor.result
            if (!current) return
            const draft = current.value as DraftEntry
            // Ownerless legacy drafts cannot be safely attributed after OAuth.
            if (typeof draft.owner === 'string' && draft.owner) {
              drafts.put({ ...draft, key: draftKey(draft.owner, draft.date) })
            }
            current.continue()
          }
        }
      }
      if (!db.objectStoreNames.contains('secureRecords')) {
        const records = db.createObjectStore('secureRecords', { keyPath: 'key' })
        records.createIndex('group', 'group')
      }
      const secureRecords = req.transaction!.objectStore('secureRecords')
      if (!secureRecords.indexNames.contains('owner')) secureRecords.createIndex('owner', 'ownerHash')
      if (!db.objectStoreNames.contains('draftKeyMarkers')) db.createObjectStore('draftKeyMarkers', { keyPath: 'ownerHash' })
    }
    req.onblocked = () => {
      // A still-open older tab may hold the previous database version. The
      // request will continue when it closes; don't reject and lose the upgrade.
      console.warn('Diary cache upgrade is waiting for another open tab to close.')
      setDatabaseNotice('blocked')
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        if (slot === 'cache') _db = null
        if (slot === 'secure') _secureDb = null
        if (slot !== 'probe' && (slot !== 'cache' || !localUpgradeInProgress)) setDatabaseNotice('versionchange')
      }
      if (databaseNotice === 'blocked') setDatabaseNotice(null)
      resolve(db)
    }
    req.onerror = () => {
      if (databaseNotice === 'blocked') setDatabaseNotice(null)
      reject(req.error)
    }
  })
}

export function getDiaryDatabase(): Promise<IDBDatabase> {
  if (!_secureDb) {
    localUpgradeInProgress = true
    _secureDb = (async () => {
      // Old releases close their IndexedDB connection on versionchange but do
      // not warn about pending edits. Ask the user to close those tabs before
      // starting the incompatible upgrade. Do not alter any draft yet.
      const probe = await openDB(undefined, 'probe')
      const oldSchema = (probe.version > 1 && probe.version < DB_VERSION) ||
        !probe.objectStoreNames.contains('secureRecords') || !probe.objectStoreNames.contains('draftKeyMarkers')
      probe.close()
      if (oldSchema) {
        await new Promise<void>(resolve => {
          resolveUpgradeConfirmation = resolve
          setDatabaseNotice('confirm-upgrade')
        })
      }
      return openDB(DB_VERSION, 'secure')
    })().catch(e => { _secureDb = null; throw e }).finally(() => { localUpgradeInProgress = false })
  }
  return _secureDb
}

function getDB(): Promise<IDBDatabase> {
  if (!_db) _db = openDB(undefined, 'cache').catch(e => { _db = null; throw e })
  return _db
}

function idbOp<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getAllCached(): Promise<CachedEntry[]> {
  const db = await getDB()
  return idbOp(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
}

export async function putCached(entry: CachedEntry): Promise<void> {
  const db = await getDB()
  await idbOp(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry))
}

export async function deleteCached(date: string): Promise<void> {
  const db = await getDB()
  await idbOp(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(date))
}

export async function getDraft(date: string, owner?: string): Promise<DraftEntry | undefined> {
  const db = await getDB()
  const row = await idbOp(db.transaction(ACCOUNT_DRAFTS_STORE, 'readonly').objectStore(ACCOUNT_DRAFTS_STORE).get(draftKey(owner, date))) as (DraftEntry & { key: string }) | undefined
  if (!row) return undefined
  const { key: _key, ...draft } = row
  return draft
}

export async function getAllDrafts(owner?: string): Promise<DraftEntry[]> {
  const db = await getDB()
  const rows = await idbOp(db.transaction(ACCOUNT_DRAFTS_STORE, 'readonly').objectStore(ACCOUNT_DRAFTS_STORE).getAll()) as (DraftEntry & { key: string })[]
  return rows.filter(row => owner === undefined || row.owner === owner).map(({ key: _key, ...draft }) => draft)
}

export async function putDraft(draft: DraftEntry): Promise<void> {
  const db = await getDB()
  await idbOp(db.transaction(ACCOUNT_DRAFTS_STORE, 'readwrite').objectStore(ACCOUNT_DRAFTS_STORE).put({ ...draft, key: draftKey(draft.owner, draft.date) }))
}

export async function deleteDraft(date: string, owner?: string, expectedContent?: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(ACCOUNT_DRAFTS_STORE, 'readwrite')
  const store = tx.objectStore(ACCOUNT_DRAFTS_STORE)
  const key = draftKey(owner, date)
  if (expectedContent === undefined) await idbOp(store.delete(key))
  else {
    const request = store.get(key)
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        if ((request.result as DraftEntry | undefined)?.content === expectedContent) store.delete(key)
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  }
}

export async function markDraftConflicted(expected: DraftEntry): Promise<boolean> {
  if (!expected.owner) return false
  const db = await getDB()
  const tx = db.transaction(ACCOUNT_DRAFTS_STORE, 'readwrite')
  const store = tx.objectStore(ACCOUNT_DRAFTS_STORE)
  const key = draftKey(expected.owner, expected.date)
  const request = store.get(key)
  return new Promise<boolean>((resolve, reject) => {
    request.onsuccess = () => {
      const current = request.result as (DraftEntry & { key: string }) | undefined
      if (!current || current.content !== expected.content || current.savedAt !== expected.savedAt) {
        resolve(false)
        return
      }
      store.put({ ...current, conflicted: true })
      resolve(true)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  // Drafts, including unattributed legacy records, are recovery data. Never
  // delete them as a side effect of a cache clear or account transition.
  const tx = db.transaction(STORE, 'readwrite')
  await new Promise<void>((resolve, reject) => {
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Cache clear aborted'))
    tx.onerror = () => { /* onabort reports the failure. */ }
  })
}
