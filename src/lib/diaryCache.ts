import type { DiaryEntry, DriveFileMeta } from '../types'

const DB_NAME = 'linger_diary_cache'
const DB_VERSION = 2
const STORE = 'entries'
const DRAFTS_STORE = 'drafts'

export interface CachedEntry {
  date: string
  meta: DriveFileMeta
  content?: DiaryEntry
  snippet?: string
}

// An edit that could not reach Drive (typically because the device was
// offline). baseVersion/baseContent capture the entry state the edit was made
// against, so a later sync still goes through normal conflict detection.
export interface DraftEntry {
  date: string
  content: string
  baseVersion: string | null
  baseContent: string | null
  savedAt: number
  // Set when a background sync hit a conflict; the draft is then left for the
  // user to resolve in the editor instead of being retried automatically.
  conflicted?: boolean
}

let _db: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'date' })
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE, { keyPath: 'date' })
    }
    req.onsuccess = () => resolve(req.result)
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

export async function getDraft(date: string): Promise<DraftEntry | undefined> {
  const db = await getDB()
  return idbOp(db.transaction(DRAFTS_STORE, 'readonly').objectStore(DRAFTS_STORE).get(date))
}

export async function getAllDrafts(): Promise<DraftEntry[]> {
  const db = await getDB()
  return idbOp(db.transaction(DRAFTS_STORE, 'readonly').objectStore(DRAFTS_STORE).getAll())
}

export async function putDraft(draft: DraftEntry): Promise<void> {
  const db = await getDB()
  await idbOp(db.transaction(DRAFTS_STORE, 'readwrite').objectStore(DRAFTS_STORE).put(draft))
}

export async function deleteDraft(date: string): Promise<void> {
  const db = await getDB()
  await idbOp(db.transaction(DRAFTS_STORE, 'readwrite').objectStore(DRAFTS_STORE).delete(date))
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([STORE, DRAFTS_STORE], 'readwrite')
  await Promise.all([
    idbOp(tx.objectStore(STORE).clear()),
    idbOp(tx.objectStore(DRAFTS_STORE).clear()),
  ])
}
