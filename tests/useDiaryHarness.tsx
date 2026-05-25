import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useDiary, EntryConflictError } from '../src/hooks/useDiary'
import type { LoadedDiaryEntry } from '../src/types'

type FetchCall = { url: string; method: string; body?: string }
type QueuedResponse = { status: number; body: unknown; delayMs?: number }

const fetchCalls: FetchCall[] = []
const queue: QueuedResponse[] = []
const evictedCalls: string[][] = []
let currentEmail: string | null = 'user@example.com'
let _setSelectedDate: ((date: string | undefined) => void) | null = null

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), method: String(init?.method ?? 'GET'), body: typeof init?.body === 'string' ? init.body : undefined })
  const resp = queue.shift()
  if (!resp) throw new Error(`Unexpected fetch: ${String(input)}`)
  if (resp.delayMs) {
    await new Promise(r => setTimeout(r, resp.delayMs))
  }
  return {
    status: resp.status,
    ok: resp.status >= 200 && resp.status < 300,
    headers: new Headers(),
    json: async () => resp.body,
    text: async () => JSON.stringify(resp.body),
  } as Response
}

type SaveFn = (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
type GetContentFn = (date: string, options?: { forceNetwork?: boolean }) => Promise<LoadedDiaryEntry | null>
type SearchFn = (query: string) => Promise<{ results: { date: string; snippet: string }[]; unindexedCount: number; totalCount: number }>
type ExportAllFn = (format: 'txt' | 'md', onProgress?: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
let _save: SaveFn | null = null
let _getContent: GetContentFn | null = null
let _search: SearchFn | null = null
let _exportAll: ExportAllFn | null = null
let _refreshEntries: (() => Promise<void>) | null = null
let _retryPendingSave: (() => Promise<LoadedDiaryEntry | null>) | null = null
let expiredCount = 0
let progressCalls: { done: number; total: number }[] = []

function Harness() {
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined)

  useEffect(() => { _setSelectedDate = setSelectedDate }, [])

  const diary = useDiary(true, currentEmail, () => { expiredCount++ }, (dates) => {
    evictedCalls.push([...dates])
  }, selectedDate)

  useEffect(() => {
    _save = diary.save
    _getContent = diary.getContent
    _search = diary.search
    _exportAll = diary.exportAll
    _refreshEntries = diary.refreshEntries
    _retryPendingSave = diary.retryPendingSave
  })

  return (
    <div
      id={diary.loading ? 'harness-loading' : 'harness-ready'}
      data-dates={diary.dates.join(',')}
    >
      {diary.loading ? 'loading' : 'ready'}
    </div>
  )
}

const root = createRoot(document.getElementById('root') as HTMLElement)

window.diaryHarness = {
  q: (...responses) => queue.push(...responses),
  calls: () => [...fetchCalls],
  clearCalls: () => fetchCalls.splice(0),
  start: () => root.render(<Harness />),
  save: async (date, content, baseVersion, force, baseContent) => {
    if (!_save) throw new Error('harness not started')
    try {
      const result = await _save(date, content, baseVersion, force, baseContent)
      return { ok: true, result }
    } catch (e) {
      if (e instanceof EntryConflictError) {
        return { ok: false, conflict: e.remote, error: 'conflict' }
      }
      return { ok: false, conflict: null, error: String(e) }
    }
  },
  triggerGetContent: async (date, options) => {
    if (!_getContent) throw new Error('harness not started')
    return _getContent(date, options)
  },
  search: async (query) => {
    if (!_search) throw new Error('harness not started')
    return _search(query)
  },
  exportAll: async (format: 'txt' | 'md' = 'txt') => {
    if (!_exportAll) throw new Error('harness not started')
    progressCalls = []
    return _exportAll(format, (done, total) => progressCalls.push({ done, total }))
  },
  refreshEntries: async () => {
    if (!_refreshEntries) throw new Error('harness not started')
    await _refreshEntries()
  },
  retryPendingSave: async () => {
    if (!_retryPendingSave) throw new Error('harness not started')
    try {
      const result = await _retryPendingSave()
      return { ok: true, result }
    } catch (e) {
      if (e instanceof EntryConflictError) {
        return { ok: false, conflict: e.remote, error: 'conflict' }
      }
      return { ok: false, conflict: null, error: String(e) }
    }
  },
  progressCalls: () => [...progressCalls],
  resetFolderState: () => {
    queue.splice(0)
    fetchCalls.splice(0)
    progressCalls = []
  },
  expiredCalls: () => expiredCount,
  clearExpiredCalls: () => { expiredCount = 0 },
  evictedCalls: () => evictedCalls.map(d => [...d]),
  clearEvictedCalls: () => { evictedCalls.splice(0) },
  setEmail: (e: string | null) => { currentEmail = e },
  setSelectedDate: (date: string | undefined) => { _setSelectedDate?.(date) },
  seedLocalStorageUser: (u: string | null) => {
    if (u === null) localStorage.removeItem('linger_session_user')
    else localStorage.setItem('linger_session_user', u)
  },
  seedIdb: async (entries: { date: string; meta: unknown; content?: unknown; snippet?: string }[]) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('linger_diary_cache', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('entries', { keyPath: 'date' })
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    await Promise.all(entries.map(e => new Promise<void>((res, rej) => {
      const req = db.transaction('entries', 'readwrite').objectStore('entries').put(e)
      req.onsuccess = () => res()
      req.onerror = () => rej(req.error)
    })))
    db.close()
  },
}
