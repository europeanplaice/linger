import type { DiaryEntry, DriveFileMeta } from '../types'

const DB_NAME = 'linger_diary_cache'
const DB_VERSION = 3
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

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
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
    }
    req.onblocked = () => {
      // A still-open older tab may hold the previous database version. The
      // request will continue when it closes; don't reject and lose the upgrade.
      console.warn('Diary cache upgrade is waiting for another open tab to close.')
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        _db = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
}

function getDB(): Promise<IDBDatabase> {
  if (!_db) _db = openDB().catch(e => { _db = null; throw e })
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
  const tx = db.transaction([STORE, DRAFTS_STORE, ACCOUNT_DRAFTS_STORE], 'readwrite')
  await Promise.all([
    idbOp(tx.objectStore(STORE).clear()),
    idbOp(tx.objectStore(DRAFTS_STORE).clear()),
    new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(ACCOUNT_DRAFTS_STORE).openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) { resolve(); return }
        // Account-owned drafts are durable recovery data. They remain partitioned
        // by owner and are only visible after that same account is authenticated.
        if (!(current.value as DraftEntry).owner) current.delete()
        current.continue()
      }
      cursor.onerror = () => reject(cursor.error)
    }),
  ])
}
