import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useDiary, EntryConflictError } from '../src/hooks/useDiary'
import { confirmLegacyUpgrade, getDatabaseNotice, putCached, putDraft, subscribeDatabaseNotice } from '../src/lib/diaryCache'
import { getAllDrafts } from '../src/lib/draftStorage'
import { setActiveAccount } from '../src/lib/accountSession'
import { clearVaultKey, unlockVaultWithKey } from '../src/lib/passkeyVault'
import type { CachedEntry } from '../src/lib/diaryCache'
import type { LoadedDiaryEntry } from '../src/types'
import type { ImportResult } from '../src/hooks/useDiary'

subscribeDatabaseNotice(() => { if (getDatabaseNotice() === 'confirm-upgrade') queueMicrotask(confirmLegacyUpgrade) })

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
type GetContentFn = (date: string, options?: { forceNetwork?: boolean; background?: boolean }) => Promise<LoadedDiaryEntry | null>
type SearchFn = (query: string) => Promise<{ results: { date: string; snippet: string }[]; unindexedCount: number; totalCount: number }>
type ExportAllFn = (onProgress?: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
type ImportAllFn = (entries: { date: string; content: string }[], onProgress?: (done: number, total: number) => void) => Promise<ImportResult>
let _save: SaveFn | null = null
let _getContent: GetContentFn | null = null
let _search: SearchFn | null = null
let _exportAll: ExportAllFn | null = null
let _importAll: ImportAllFn | null = null
let _refreshEntries: (() => Promise<void>) | null = null
let _retryPendingSave: (() => Promise<LoadedDiaryEntry | null>) | null = null
let expiredCount = 0
let progressCalls: { done: number; total: number }[] = []

function Harness() {
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined)

  useEffect(() => { _setSelectedDate = setSelectedDate }, [])

  const diary = useDiary('signedIn', currentEmail, () => { expiredCount++ }, (dates) => {
    evictedCalls.push([...dates])
  }, selectedDate)

  useEffect(() => {
    _save = diary.save
    _getContent = diary.getContent
    _search = diary.search
    _exportAll = diary.exportAll
    _importAll = diary.importAll
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
  start: () => {
    if (currentEmail) {
      unlockVaultWithKey(`harness:${currentEmail}`, new Uint8Array(32).fill(17))
      setActiveAccount(`email:${encodeURIComponent(currentEmail)}`, false, currentEmail)
    } else {
      clearVaultKey()
      setActiveAccount(null)
    }
    root.render(<Harness />)
  },
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
  exportAll: async () => {
    if (!_exportAll) throw new Error('harness not started')
    progressCalls = []
    return _exportAll((done, total) => progressCalls.push({ done, total }))
  },
  importAll: async (entries) => {
    if (!_importAll) throw new Error('harness not started')
    progressCalls = []
    try {
      const result = await _importAll(entries, (done, total) => progressCalls.push({ done, total }))
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
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
  seedIdb: async (entries: { owner?: string; date: string; meta: unknown; content?: unknown; snippet?: string }[]) => {
    await Promise.all(entries.map(e => putCached(e as CachedEntry)))
  },
  seedDrafts: async (drafts) => {
    const owner = localStorage.getItem('linger_session_user') ?? currentEmail ?? undefined
    await Promise.all(drafts.map(d => putDraft({ ...d, owner })))
  },
  getDrafts: () => getAllDrafts(currentEmail ?? undefined),
}
