import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { DiaryEntry, DriveFileMeta, LoadedDiaryEntry } from '../types'
import { listEntries, searchEntries, getEntryByDate, saveEntry, deleteEntry, getChanges, TokenExpiredError, SaveConflictError, DriveHttpError } from '../api/driveEntries'
import { getAllCached, putCached, deleteCached, clearCache, getAllDrafts, putDraft, deleteDraft } from '../lib/diaryCache'
import type { CachedEntry, DraftEntry } from '../lib/diaryCache'
import { LocalStorageAdapter } from '../lib/storageAdapter'
import { SyncQueueManager } from '../lib/syncQueue'
import { broadcastMessage } from '../utils/tabSync'
import { getAccountSnapshot } from '../lib/accountSession'
import type { AuthStatus } from './useAuth'
import { shiftDate } from '../utils/date'
import { useLatestRef } from './useEvent'

interface EntryCache {
  meta: DriveFileMeta
  content?: DiaryEntry
  snippet?: string
}

interface DiaryScope {
  active: boolean
  ready: boolean
  cacheReady: Promise<void>
  releaseCache: () => void
  controller: AbortController
  authStatus: AuthStatus
  email: string | null
}

export interface DiaryState {
  loading: boolean
  freshListLoaded: boolean
  error: string | null
  deletionCancelled: boolean
  dates: string[]                                      // sorted desc
  hasLegacyMdFiles: boolean                            // any entry still stored as .md (pre-.txt migration)
  getContent: (date: string, options?: { forceNetwork?: boolean; background?: boolean }) => Promise<LoadedDiaryEntry | null>
  save: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  remove: (date: string, target?: { fileId: string; baseVersion: string }) => Promise<void>
  search: (query: string) => Promise<SearchResult>
  refreshEntries: () => Promise<void>
  prefetch: (dates: string[], concurrency?: number) => Promise<void>
  retryPendingSave: () => Promise<LoadedDiaryEntry | null>
  exportAll: (onProgress?: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
  importAll: (entries: { date: string; content: string }[], onProgress?: (done: number, total: number) => void) => Promise<ImportResult>
}

export interface ImportResult {
  imported: string[]
  skipped: string[]
  failed: string[]
}

export interface SearchResult {
  results: { date: string; snippet: string }[]
  unindexedCount: number
  totalCount: number
}

export class EntryConflictError extends Error {
  remote: LoadedDiaryEntry | null

  constructor(remote: LoadedDiaryEntry | null) {
    super('Entry was changed on another device')
    this.name = 'EntryConflictError'
    this.remote = remote
  }
}

type PendingSave = { date: string; content: string; baseVersion: string | null; baseContent?: string | null }

const SEARCH_RESULT_LIMIT = 30

// Cadence for the while-online draft replay poll (see the poll effect below).
const DRAFT_RETRY_INTERVAL_MS = 10_000
const SEARCH_REMOTE_FETCH_LIMIT = 30

// All prefetch traffic (month warmup, neighbours, recollection, recent entries)
// shares this budget so bursts can't pile up and rate-limit Drive while the
// user is waiting on an entry they actually opened.
const BG_FETCH_CONCURRENCY = 2

function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

function headSnippet(text: string): string {
  return text.slice(0, 120).replace(/\n/g, ' ')
}

// Substring-match every term (case-insensitive, falling back to NFKC
// normalization so half/full-width forms match); the snippet centres on the
// first term's match. Returns null when any term is missing.
function localMatchSnippet(text: string, terms: string[]): string | null {
  const plain = text.toLowerCase()
  let normalized: string | null = null
  let snippetSource = text
  let snippetIdx = -1
  for (const term of terms) {
    let idx = plain.indexOf(term.toLowerCase())
    let source = text
    if (idx === -1) {
      normalized ??= normalizeForSearch(text)
      idx = normalized.indexOf(normalizeForSearch(term))
      source = normalized
    }
    if (idx === -1) return null
    if (snippetIdx === -1) {
      snippetIdx = idx
      snippetSource = source
    }
  }
  return snippetSource.slice(Math.max(0, snippetIdx - 40), snippetIdx + 80).replace(/\n/g, ' ')
}

// A failure worth keeping the edit as a durable local draft: the device is offline
// or the request died at the network layer (no HTTP response ever came back), or
// our own proxy answered 5xx — meaning the server-side token refresh failed
// transiently (see functions/api/_middleware.ts) and the session is still alive,
// so the save is worth replaying once the blip passes, exactly like offline.
function isNetworkFailure(e: unknown): boolean {
  return (typeof navigator !== 'undefined' && !navigator.onLine) || e instanceof TypeError || (e instanceof DriveHttpError && e.status >= 500)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    for (;;) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

export function useDiary(authStatus: AuthStatus, email: string | null, onExpired: () => void, onEntriesEvicted?: (dates: string[]) => void, selectedDate?: string): DiaryState {
  const isSignedIn = authStatus === 'signedIn'
  const [loading, setLoading] = useState(false)
  const [freshListLoaded, setFreshListLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletionCancelled, setDeletionCancelled] = useState(false)
  const [cache, setCache] = useState<Map<string, EntryCache>>(new Map())
  const cacheRef = useLatestRef(cache)
  const saveQueueRef = useRef<Map<string, Promise<unknown>>>(new Map())
  const inflightRef = useRef<Map<string, Promise<LoadedDiaryEntry | null>>>(new Map())
  // Low-priority fetch scheduler: queued background tasks, a promote handle per
  // queued date (so a user navigation jumps the queue), and active counters.
  const bgQueueRef = useRef<{ date: string; start: () => void; cancel: () => void }[]>([])
  const bgPromoteRef = useRef<Map<string, () => void>>(new Map())
  const bgActiveRef = useRef(0)
  const fgActiveRef = useRef(0)
  const pendingSaveRef = useRef<PendingSave | null>(null)
  const replayingDraftsRef = useRef(false)
  const onExpiredRef = useLatestRef(onExpired)
  const onEvictedRef = useLatestRef(onEntriesEvicted)

  const storageAdapter = useMemo(() => new LocalStorageAdapter(), [])
  const syncQueue = useMemo(() => new SyncQueueManager(email ?? undefined), [email])
  const scopeRef = useRef<DiaryScope | null>(null)

  // Each committed authentication state owns its asynchronous work. Keep the
  // captured scope invalid even if the same account later signs back in.
  useEffect(() => {
    let releaseCache!: () => void
    const cacheReady = new Promise<void>(resolve => { releaseCache = resolve })
    const scope: DiaryScope = { active: true, ready: false, cacheReady, releaseCache, controller: new AbortController(), authStatus, email }
    scopeRef.current = scope
    cacheRef.current = new Map()
    setCache(new Map())
    setDeletionCancelled(false)
    inflightRef.current.clear()
    saveQueueRef.current.clear()
    pendingSaveRef.current = null
    replayingDraftsRef.current = false
    bgQueueRef.current.splice(0).forEach(task => task.cancel())
    bgActiveRef.current = 0
    fgActiveRef.current = 0
    return () => { scope.active = false; scope.releaseCache(); scope.controller.abort() }
  }, [authStatus, email])

  const getScope = useCallback(() => {
    const scope = scopeRef.current
    return scope?.active && scope.authStatus === authStatus && scope.email === email ? scope : null
  }, [authStatus, email])

  // Wipes everything persisted for the current account: the IDB entry/draft
  // cache, the local entry mirror, and the offline sync queue. Anything left
  // behind would leak into (or replay against) the next signed-in account.
  const clearLocalData = useCallback(async (): Promise<void> => {
    await Promise.all([
      clearCache(),
      storageAdapter.clearAll().catch(() => {}),
      syncQueue.clear().catch(() => {}),
    ])
  }, [storageAdapter, syncQueue])

  const updateCache = useCallback((updater: (prev: Map<string, EntryCache>) => Map<string, EntryCache>) => {
    const scope = getScope()
    if (!scope) return
    setCache(prev => {
      if (!scope.active) return prev
      const next = updater(prev)
      cacheRef.current = next
      return next
    })
  }, [getScope])

  const loadEntryList = useCallback(async (preserveExistingContent: boolean, syncPersistentCache: boolean): Promise<Map<string, EntryCache>> => {
    const scope = getScope()
    if (!scope) return new Map()
    const files = await listEntries(scope.controller.signal)
    if (!scope.active) return new Map()

    // Compute new state and IDB diff using the current cache snapshot
    const prev = cacheRef.current
    const next = new Map<string, EntryCache>()
    const toUpsert: CachedEntry[] = []
    const toDelete: string[] = []
    const prevDates = new Set(prev.keys())
    const evicted: string[] = []

    for (const f of files) {
      const date = f.name.replace('diary-', '').replace(/\.(json|md|txt)$/, '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      prevDates.delete(date)

      const existing = prev.get(date)
      const canReuseContent = Boolean(
        preserveExistingContent &&
        existing?.content &&
        existing.meta.id === f.id &&
        existing.meta.version === f.version,
      )
      if (!canReuseContent && existing?.content) evicted.push(date)
      next.set(date, canReuseContent ? { ...existing!, meta: f } : { meta: f })
      if (syncPersistentCache) {
        toUpsert.push(canReuseContent && existing?.content
          ? { date, meta: f, content: existing.content, snippet: existing.snippet }
          : { date, meta: f })
      }
    }

    for (const date of prevDates) {
      if (prev.get(date)?.content) evicted.push(date)
      if (syncPersistentCache) toDelete.push(date)
    }

    updateCache(() => next)
    if (evicted.length) onEvictedRef.current?.(evicted)

    if (syncPersistentCache) {
      // Background IDB sync — non-blocking
      Promise.all([
        ...toUpsert.map(e => putCached({ ...e, owner: scope.email ?? undefined }).catch(() => {})),
        ...toDelete.map(d => deleteCached(d).catch(() => {})),
      ]).catch(() => {})
    }

    return next
  }, [updateCache, getScope])

  // Starts queued background fetches while no user-initiated load is running
  // and the background budget has room.
  const pumpBgQueue = useCallback(() => {
    while (fgActiveRef.current === 0 && bgActiveRef.current < BG_FETCH_CONCURRENCY) {
      const task = bgQueueRef.current.shift()
      if (!task) return
      task.start()
    }
  }, [])

  const getContent = useCallback(async (date: string, options: { forceNetwork?: boolean; background?: boolean } = {}): Promise<LoadedDiaryEntry | null> => {
    // Child editor effects run before this hook's parent effects on sign-in.
    // Let the committed account scope initialize, then wait only for its local
    // cache, so a cached entry never flashes as empty or waits for Drive sync.
    await Promise.resolve()
    const scope = getScope()
    if (!isSignedIn || !scope) return null
    await scope.cacheReady
    if (!scope.active) return null

    const cached = cacheRef.current.get(date)
    // Content is already in memory (verified by listEntries version check or saved this session)
    if (cached?.content && !options.forceNetwork) return { entry: cached.content, meta: cached.meta }

    // Dedupe concurrent fetches of the same entry — hover-intent, adjacent-day,
    // and month prefetch can all race for one date.
    if (!options.forceNetwork) {
      // A user-initiated load of a date that is still waiting in the background
      // queue starts it right now instead of behind the rest of the queue.
      if (!options.background) bgPromoteRef.current.get(date)?.()
      const inflight = inflightRef.current.get(date)
      if (inflight) return inflight
    }

    const doFetch = async (): Promise<LoadedDiaryEntry | null> => {
      if (!scope.active) return null
      try {
        const current = cacheRef.current.get(date)
        const loaded = await getEntryByDate(date, undefined, current?.meta.id, scope.controller.signal)
        if (!scope.active) return null
        if (!loaded || loaded === 'not-modified') {
          if (options.forceNetwork && current) {
            updateCache(prev => {
              const next = new Map(prev)
              next.delete(date)
              return next
            })
            if (email !== null) deleteCached(date).catch(() => {})
          }
          return null
        }
        const { entry: content, meta } = loaded
        updateCache(prev => {
          const next = new Map(prev)
          const existing = next.get(date)
          if (existing) {
            const existingV = Number(existing.meta.version ?? 0)
            const fetchedV = Number(meta.version ?? 0)
            const safeMeta = fetchedV >= existingV ? meta : existing.meta
            next.set(date, { ...existing, meta: safeMeta, content, snippet: existing.snippet ?? content.content.slice(0, 500) })
          } else {
            next.set(date, { meta, content, snippet: content.content.slice(0, 500) })
          }
          return next
        })
        if (email !== null) putCached({ owner: email, date, meta, content, snippet: content.content.slice(0, 500) }).catch(() => {})
        return { entry: content, meta }
      } catch (e) {
        if (!scope.active) return null
        if (e instanceof TokenExpiredError) { onExpiredRef.current(); throw e }
        throw e
      }
    }

    let fetchPromise: Promise<LoadedDiaryEntry | null>
    if (options.background && !options.forceNetwork) {
      fetchPromise = new Promise<LoadedDiaryEntry | null>((resolve, reject) => {
        const start = (foreground: boolean) => {
          bgPromoteRef.current.delete(date)
          const queued = bgQueueRef.current.findIndex(t => t.date === date)
          if (queued !== -1) bgQueueRef.current.splice(queued, 1)
          if (foreground) fgActiveRef.current++
          else bgActiveRef.current++
          doFetch().then(resolve, reject).finally(() => {
            if (!scope.active) return
            if (foreground) fgActiveRef.current--
            else bgActiveRef.current--
            pumpBgQueue()
          })
        }
        bgQueueRef.current.push({ date, start: () => start(false), cancel: () => { bgPromoteRef.current.delete(date); resolve(null) } })
        bgPromoteRef.current.set(date, () => start(true))
      })
    } else {
      fgActiveRef.current++
      fetchPromise = doFetch().finally(() => {
        if (!scope.active) return
        fgActiveRef.current--
        pumpBgQueue()
      })
    }

    if (!options.forceNetwork) {
      inflightRef.current.set(date, fetchPromise)
      fetchPromise
        .catch(() => {})
        .finally(() => {
          if (inflightRef.current.get(date) === fetchPromise) inflightRef.current.delete(date)
        })
    }
    if (options.background) pumpBgQueue()
    return fetchPromise
  }, [isSignedIn, email, updateCache, pumpBgQueue, getScope])

  // Load entry list when signed in
  useEffect(() => {
    const scope = getScope()
    if (!scope) return
    if (!isSignedIn) {
      scope.releaseCache()
      setFreshListLoaded(false)
      setLoading(false)
      // Only wipe the persistent cache once the session is known to be gone;
      // while auth is still restoring ('initializing') the cache must survive
      // so the IDB preload below has data after a reload.
      if (authStatus === 'signedOut') {
        // A stale tab must not wipe the new account's shared cache. Its own
        // offline queue is partitioned by account and can always be discarded.
        const storedUser = localStorage.getItem('linger_session_user')
        if (getAccountSnapshot().clearSharedData && (!storedUser || storedUser === email)) clearLocalData().catch(() => {})
        else syncQueue.clear().catch(() => {})
      }
      return
    }
    setFreshListLoaded(false)
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        // If the signed-in account differs from the last known account, evict all
        // local data (IDB cache/drafts, entry mirror, offline queue) before
        // hydrating to prevent one user's diary from briefly appearing to another.
        const canUsePersistentCache = email !== null
        const storedUser = localStorage.getItem('linger_session_user')
        if (!canUsePersistentCache) {
          await clearLocalData()
          if (!scope.active) return
          localStorage.removeItem('linger_session_user')
        } else if (storedUser !== email) {
          await clearLocalData()
          if (storedUser) await new SyncQueueManager(storedUser).clear()
          if (!scope.active) return
          localStorage.setItem('linger_session_user', email)
        }

        // Preload from IDB immediately so the sidebar and previously-opened entries
        // appear without waiting for the Drive network round trip.
        const idbEntries = canUsePersistentCache ? (await getAllCached().catch(() => [] as CachedEntry[])).filter(e => e.owner === undefined || e.owner === email) : []
        if (!scope.active) return
        if (idbEntries.length > 0) {
          const hydrated = new Map<string, EntryCache>()
          for (const e of idbEntries) hydrated.set(e.date, { meta: e.meta, content: e.content, snippet: e.snippet })
          cacheRef.current = hydrated
          updateCache(() => hydrated)
          setLoading(false)
        }
        scope.releaseCache()
        // Always sync with Drive to pick up remote changes and evict stale content.
        // Fire getEntryByDate for today in parallel so the editor can render
        // without waiting for the full file list to complete.
        const today = new Date().toISOString().split('T')[0]
        const [prefetchedToday, freshCache] = await Promise.all([
          getEntryByDate(today, undefined, undefined, scope.controller.signal).catch(() => null),
          loadEntryList(true, canUsePersistentCache),
        ])
        if (!scope.active) return
        scope.ready = true
        setFreshListLoaded(true)

        // Merge pre-fetched today content into the reconciled cache.
        // This runs inside the updater to avoid a race with concurrent
        // React state batching — we always read from the latest prev.
        if (prefetchedToday && prefetchedToday !== 'not-modified') {
          updateCache(prev => {
            const existing = prev.get(today)
            if (existing &&
                existing.meta.id === prefetchedToday.meta.id &&
                existing.meta.version === prefetchedToday.meta.version &&
                !existing.content) {
              const next = new Map(prev)
              next.set(today, {
                ...existing,
                content: prefetchedToday.entry,
                snippet: existing.snippet ?? prefetchedToday.entry.content.slice(0, 500),
              })
              if (email !== null) putCached({
                owner: email,
                date: today,
                meta: prefetchedToday.meta,
                content: prefetchedToday.entry,
                snippet: prefetchedToday.entry.content.slice(0, 500),
              }).catch(() => {})
              return next
            }
            return prev
          })
        }

        // Prefetch the 3 most recent entries that aren't already in memory,
        // excluding today (already pre-fetched above).
        const recentDates = Array.from(freshCache.keys())
          .sort((a, b) => b.localeCompare(a))
          .filter(d => d !== today)
          .slice(0, 3)
          .filter(d => !freshCache.get(d)?.content)
        for (const d of recentDates) {
          getContent(d, { background: true }).catch(() => {})
        }
      } catch (e) {
        if (!scope.active) return
        if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
        console.error('Failed to load diary entries:', e)
        setError(String(e))
        setFreshListLoaded(false)
      } finally {
        scope.releaseCache()
        if (scope.active) setLoading(false)
      }
    })()
  }, [authStatus, isSignedIn, email, loadEntryList, updateCache, getContent, clearLocalData, getScope, syncQueue])

  const refreshEntries = useCallback(async (): Promise<void> => {
    const scope = getScope()
    if (!isSignedIn || !scope) return
    try {
      const { changes } = await getChanges(scope.controller.signal)
      if (!scope.active) return
      if (changes.length === 0) {
        // First-time token initialisation — the full list already ran on sign-in.
        return
      }

      const syncPersistentCache = email !== null
      const toUpsert: CachedEntry[] = []
      const toDelete: string[] = []
      const evicted: string[] = []

      // Compute the next cache from the current snapshot (side-effect-free updater).
      const next = new Map(cacheRef.current)
      for (const change of changes) {
        if (change.removed || change.file?.trashed) {
          // Removed changes typically omit the file object — match by fileId.
          for (const [date, entry] of next) {
            if (entry.meta.id === change.fileId) {
              if (entry.content) evicted.push(date)
              next.delete(date)
              toDelete.push(date)
              break
            }
          }
          continue
        }

        const name = change.file?.name ?? ''
        const date = name.replace('diary-', '').replace(/\.(json|md|txt)$/, '')
        // Only act on diary files matching the expected pattern.
        if (!/^diary-\d{4}-\d{2}-\d{2}\.(md|txt)$/.test(name) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

        const meta: DriveFileMeta = {
          id: change.file!.id,
          name: change.file!.name,
          modifiedTime: change.file!.modifiedTime,
          version: change.file!.version,
        }
        const existing = next.get(date)
        if (existing) {
          // Version changed → evict content so it is re-fetched on next access.
          if (existing.meta.version !== meta.version) {
            if (existing.content) evicted.push(date)
            next.set(date, { meta })
            toUpsert.push({ date, meta })
          } else {
            next.set(date, { ...existing, meta })
          }
        } else {
          // New file added on another device.
          next.set(date, { meta })
          toUpsert.push({ date, meta })
        }
      }

      updateCache(() => next)
      if (evicted.length) onEvictedRef.current?.(evicted)
      if (syncPersistentCache) {
        Promise.all([
          ...toUpsert.map(e => putCached({ ...e, owner: scope.email ?? undefined }).catch(() => {})),
          ...toDelete.map(d => deleteCached(d).catch(() => {})),
        ]).catch(() => {})
      }
    } catch (e) {
      if (!scope.active) return
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      throw e
    }
  }, [isSignedIn, email, updateCache, getScope])

  const save = useCallback(async (date: string, content: string, baseVersion: string | null, force = false, baseContent?: string | null): Promise<LoadedDiaryEntry> => {
    const scope = getScope()
    if (!isSignedIn || !scope) throw new Error('Not signed in')

    const prev = saveQueueRef.current.get(date) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(async (): Promise<LoadedDiaryEntry> => {
      if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
      const entry: DiaryEntry = { date, content }
      try {
        const cachedMeta = cacheRef.current.get(date)?.meta ?? null
        const meta = await saveEntry(date, entry, { fileId: cachedMeta?.id, baseVersion, baseContent, force, signal: scope.controller.signal })
        if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
        updateCache(p => {
          const next = new Map(p)
          next.set(date, { meta, content: entry, snippet: entry.content.slice(0, 500) })
          return next
        })
        if (email !== null) putCached({ owner: email, date, meta, content: entry, snippet: entry.content.slice(0, 500) }).catch(() => {})
        storageAdapter.saveEntry(date, content).catch(() => {})
        broadcastMessage({ type: 'DIARY_UPDATED', date })
        deleteDraft(date).catch(() => {})
        return { entry, meta }
      } catch (e) {
        if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
        if (e instanceof TokenExpiredError) {
          pendingSaveRef.current = { date, content, baseVersion, baseContent }
          onExpiredRef.current()
          throw e
        }
        if (email !== null && !(e instanceof SaveConflictError) && isNetworkFailure(e)) {
          // The save never reached Drive — keep the edit as a durable local
          // draft so it survives a reload and is synced once back online.
          // Replay is handled solely by the drafts loop below (it knows how
          // to skip the date open in the editor and mark conflicts) — do not
          // also enqueue this in syncQueue, which would replay it a second time.
          putDraft({ owner: email, date, content, baseVersion, baseContent: baseContent ?? null, savedAt: Date.now() }).catch(() => {})
        }
        if (e instanceof SaveConflictError) {
          if (e.remote) {
            updateCache(p => {
              const next = new Map(p)
              next.set(date, { meta: e.remote!.meta, content: e.remote!.entry, snippet: e.remote!.entry.content.slice(0, 500) })
              return next
            })
          } else {
            updateCache(p => {
              const next = new Map(p)
              next.delete(date)
              return next
            })
          }
          throw new EntryConflictError(e.remote)
        }
        throw e
      } finally {
        if (saveQueueRef.current.get(date) === run) saveQueueRef.current.delete(date)
      }
    })
    saveQueueRef.current.set(date, run)
    return run
  }, [isSignedIn, email, updateCache, storageAdapter, getScope])

  const selectedDateRef = useLatestRef(selectedDate)

  // Push drafts persisted while offline back to Drive. Runs after the initial
  // Drive sync and whenever connectivity returns. The date open in the editor
  // is skipped — the editor owns that draft and retries it itself.
  const replayDrafts = useCallback(async (): Promise<void> => {
    const scope = getScope()
    if (!isSignedIn || !scope?.ready || replayingDraftsRef.current) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    replayingDraftsRef.current = true
    try {
      await syncQueue.process(async (item) => {
        if (!scope.active) return false
        try {
          if (item.type === 'REMOVE') {
            // Legacy queues lack an identity/version precondition. Cancel them
            // rather than apply an old intention to a newly created entry.
            if (!item.fileId || !item.baseVersion) { setDeletionCancelled(true); return true }
            await deleteEntry(item.date, scope.controller.signal, { fileId: item.fileId, baseVersion: item.baseVersion })
            if (!scope.active) return false
            updateCache(prev => {
              const next = new Map(prev)
              next.delete(item.date)
              return next
            })
            storageAdapter.deleteEntry(item.date).catch(() => {})
            deleteCached(item.date).catch(() => {})
            broadcastMessage({ type: 'DIARY_REMOVED', date: item.date })
          }
          return true
        } catch (e) {
          if (e instanceof SaveConflictError) {
            if (!scope.active) return false
            setDeletionCancelled(true)
            return true
          }
          return false
        }
      }).catch(() => {})

      const drafts = await getAllDrafts().catch(() => [] as DraftEntry[])
      for (const draft of drafts) {
        if (!scope.active) return
        if (draft.owner !== undefined && draft.owner !== scope.email) continue
        if (draft.conflicted) continue
        if (draft.date === selectedDateRef.current) continue
        const cached = cacheRef.current.get(draft.date)
        if (cached?.content?.content === draft.content) {
          deleteDraft(draft.date).catch(() => {})
          continue
        }
        try {
          await save(draft.date, draft.content, draft.baseVersion, false, draft.baseContent)
        } catch (e) {
          if (!scope.active) return
          if (e instanceof TokenExpiredError) return
          if (e instanceof EntryConflictError) {
            // Leave resolution to the user in the editor; stop auto-retrying.
            putDraft({ ...draft, conflicted: true }).catch(() => {})
          }
          // Network failures: the draft stays for the next replay.
        }
      }
    } finally {
      if (scope.active) replayingDraftsRef.current = false
    }
  }, [isSignedIn, save, syncQueue, storageAdapter, updateCache, getScope])

  const replayDraftsRef = useLatestRef(replayDrafts)

  useEffect(() => {
    if (!freshListLoaded) return
    replayDraftsRef.current().catch(() => {})
  }, [freshListLoaded])

  useEffect(() => {
    if (!isSignedIn) return
    const onOnline = () => { replayDraftsRef.current().catch(() => {}) }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [isSignedIn])

  // Drafts also appear while the browser stays online — a save that exhausted its
  // retries on a transient 5xx (see isNetworkFailure). No 'online' event fires for
  // that, so the listener above alone would leave them unreplayed until the next
  // page load. Poll while any non-conflicted draft lingers instead: it replays the
  // moment the blip passes, and catches the open date's draft once the user
  // navigates away from it (replayDrafts deliberately skips the open date — the
  // editor owns it). Stops as soon as nothing is left to replay.
  useEffect(() => {
    if (!isSignedIn) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (stopped || (typeof navigator !== 'undefined' && !navigator.onLine)) return
      const drafts = await getAllDrafts().catch(() => [] as DraftEntry[])
      if (stopped) return
      if (!drafts.some(d => !d.conflicted)) return
      await replayDraftsRef.current().catch(() => {})
      if (!stopped) timer = setTimeout(poll, DRAFT_RETRY_INTERVAL_MS)
    }
    timer = setTimeout(poll, DRAFT_RETRY_INTERVAL_MS)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [isSignedIn])

  const remove = useCallback(async (date: string, target?: { fileId: string; baseVersion: string }): Promise<void> => {
    const scope = getScope()
    if (!isSignedIn || !scope) throw new Error('Not signed in')
    const existing = cacheRef.current.get(date)
    if (!existing && !target) {
      deleteDraft(date).catch(() => {})
      return
    }
    const expected = target ?? (existing?.meta.version ? { fileId: existing.meta.id, baseVersion: existing.meta.version } : undefined)
    if (!expected) throw new EntryConflictError(null)
    try {
      await deleteEntry(date, scope.controller.signal, expected)
      if (!scope.active) return
      updateCache(prev => {
        const next = new Map(prev)
        next.delete(date)
        return next
      })
      storageAdapter.deleteEntry(date).catch(() => {})
      deleteCached(date).catch(() => {})
      deleteDraft(date).catch(() => {})
      broadcastMessage({ type: 'DIARY_REMOVED', date })
    } catch (e) {
      if (!scope.active) return
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); throw e }
      if (e instanceof SaveConflictError) throw new EntryConflictError(e.remote)
      if (isNetworkFailure(e)) {
        syncQueue.enqueue({
          id: `remove-${date}-${Date.now()}`,
          type: 'REMOVE',
          date,
          timestamp: Date.now(),
          fileId: expected.fileId,
          baseVersion: expected.baseVersion,
        }).catch(() => {})
      }
      throw e
    }
  }, [isSignedIn, updateCache, storageAdapter, syncQueue, getScope])

  const search = useCallback(async (query: string): Promise<SearchResult> => {
    const scope = getScope()
    if (!isSignedIn || !scope || !query.trim()) return { results: [], unindexedCount: 0, totalCount: 0 }

    const terms = query.trim().split(/\s+/).filter(Boolean)
    const cached = cacheRef.current

    // Local pass: substring-match entries whose content is already cached.
    // This works offline and catches CJK text that Drive's fullText tokenizer
    // misses.
    const found = new Map<string, string>()
    let uncachedCount = 0
    for (const [date, entry] of cached) {
      if (!entry.content) {
        uncachedCount++
        continue
      }
      const snippet = localMatchSnippet(entry.content.content, terms)
      if (snippet !== null) found.set(date, snippet)
    }

    // Remote pass: Drive fullText search covers entries without local content,
    // plus tokenizer matches that substring search can't reproduce.
    let failedCount = 0
    let unfetchedMatches = 0
    try {
      const files = await searchEntries(query, scope.controller.signal)
      if (!scope.active) return { results: [], unindexedCount: 0, totalCount: 0 }
      const candidates = files
        .map(f => ({ date: f.name.replace('diary-', '').replace(/\.(json|md|txt)$/, ''), fileId: f.id }))
        .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !found.has(date))

      const toFetch: { date: string; fileId: string }[] = []
      for (const c of candidates) {
        const text = cached.get(c.date)?.content?.content
        if (text !== undefined) {
          // Content is cached but the substring pass missed it — Drive matched
          // via tokenization, so include it with a leading snippet.
          found.set(c.date, headSnippet(text))
        } else {
          toFetch.push(c)
        }
      }

      toFetch.sort((a, b) => b.date.localeCompare(a.date))
      const limited = toFetch.slice(0, SEARCH_REMOTE_FETCH_LIMIT)
      unfetchedMatches = toFetch.length - limited.length

      await mapWithConcurrency(limited, 5, async ({ date, fileId }) => {
        if (!scope.active) return
        try {
          const loaded = await getEntryByDate(date, undefined, fileId, scope.controller.signal)
          if (!scope.active) return
          if (!loaded || loaded === 'not-modified') return
          const text = loaded.entry.content
          const snippet = localMatchSnippet(text, terms) ?? headSnippet(text)
          updateCache(prev => {
            const next = new Map(prev)
            const ex = next.get(date)
            if (ex) next.set(date, { ...ex, content: loaded.entry, snippet })
            return next
          })
          found.set(date, snippet)
        } catch {
          failedCount++
        }
      })
    } catch {
      // Drive search unavailable (offline or API error) — fall back to the
      // local results; entries without cached content could not be searched.
      failedCount = uncachedCount
    }

    if (!scope.active) return { results: [], unindexedCount: 0, totalCount: 0 }
    const results = Array.from(found, ([date, snippet]) => ({ date, snippet }))
    results.sort((a, b) => b.date.localeCompare(a.date))
    const totalCount = results.length + unfetchedMatches
    return { results: results.slice(0, SEARCH_RESULT_LIMIT), unindexedCount: failedCount, totalCount }
  }, [isSignedIn, updateCache, getScope])

  const retryPendingSave = useCallback(async (): Promise<LoadedDiaryEntry | null> => {
    const pending = pendingSaveRef.current
    if (!pending) return null
    pendingSaveRef.current = null
    return save(pending.date, pending.content, pending.baseVersion, false, pending.baseContent)
  }, [save])

  const exportAll = useCallback(async (onProgress?: (done: number, total: number) => void): Promise<{ date: string; content: string }[]> => {
    const scope = getScope()
    if (!isSignedIn || !scope) throw new Error('Not signed in')

    const dates = Array.from(cache.keys()).sort((a, b) => a.localeCompare(b))
    const total = dates.length
    let done = 0
    const results = await mapWithConcurrency(dates, 4, async (date) => {
      if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
      const loaded = await getContent(date)
      if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
      done += 1
      onProgress?.(done, total)
      const entry = loaded?.entry
      if (!entry) return { date, content: '' }
      return { date, content: entry.content }
    })

    return results
  }, [isSignedIn, cache, getContent, getScope])

  // Imports previously-exported entries. Dates that already exist locally (or
  // that the server reports as a conflict, e.g. a stale cache snapshot) are
  // skipped rather than overwritten, so a re-run or a partial migration can
  // never clobber an entry written after the export was taken.
  const importAll = useCallback(async (
    entries: { date: string; content: string }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ImportResult> => {
    const scope = getScope()
    if (!isSignedIn || !scope) throw new Error('Not signed in')

    const total = entries.length
    let done = 0
    const imported: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    await mapWithConcurrency(entries, 4, async ({ date, content }) => {
      if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
      try {
        if (cacheRef.current.has(date)) {
          skipped.push(date)
        } else {
          await save(date, content, null)
          imported.push(date)
        }
      } catch (e) {
        if (!scope.active) throw new DOMException('Diary session changed', 'AbortError')
        if (e instanceof TokenExpiredError) throw e
        if (e instanceof EntryConflictError) {
          skipped.push(date)
        } else {
          failed.push(date)
        }
      } finally {
        done += 1
        if (scope.active) onProgress?.(done, total)
      }
    })

    return { imported, skipped, failed }
  }, [isSignedIn, save, getScope])

  // Prefetch a set of dates with bounded concurrency. Skips dates that have no
  // entry or whose content is already loaded; in-flight dedup in getContent
  // prevents racing with other prefetch paths.
  const prefetch = useCallback(async (dates: string[], concurrency = 3): Promise<void> => {
    const scope = getScope()
    if (!isSignedIn || !scope) return
    const targets = dates.filter(d => cacheRef.current.has(d) && !cacheRef.current.get(d)?.content)
    if (targets.length === 0) return
    await mapWithConcurrency(targets, Math.max(1, concurrency), async (d) => {
      if (!scope.active) return
      await getContent(d, { background: true }).catch(() => {})
    })
  }, [isSignedIn, getContent, getScope])

  const getContentRef = useLatestRef(getContent)

  // Warm the neighbours of the selected day so day-nav (±1) is instant and a
  // continued scrub in either direction (±2) stays a step ahead. Only dates
  // that actually have an entry are fetched.
  useEffect(() => {
    if (!selectedDate) return
    const id = setTimeout(() => {
      ;[shiftDate(selectedDate, -1), shiftDate(selectedDate, 1), shiftDate(selectedDate, -2), shiftDate(selectedDate, 2)]
        .filter(d => cacheRef.current.has(d) && !cacheRef.current.get(d)?.content)
        .forEach(d => getContentRef.current(d, { background: true }).catch(() => {}))
    }, 300)
    return () => clearTimeout(id)
  }, [selectedDate])

  const dates = useMemo(() => getScope() ? Array.from(cache.keys()).sort((a, b) => b.localeCompare(a)) : [], [cache, getScope])
  const hasLegacyMdFiles = useMemo(() => Boolean(getScope()) && Array.from(cache.values()).some(e => /\.md$/.test(e.meta.name)), [cache, getScope])

  return { loading, freshListLoaded, error, deletionCancelled, dates, hasLegacyMdFiles, getContent, save, remove, search, refreshEntries, prefetch, retryPendingSave, exportAll, importAll }
}
