import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { DiaryEntry, DriveFileMeta, LoadedDiaryEntry } from '../types'
import { listEntries, searchEntries, getEntryByDate, saveEntry, deleteEntry, getChanges, TokenExpiredError, SaveConflictError } from '../api/driveEntries'
import { getAllCached, putCached, deleteCached, clearCache, getAllDrafts, putDraft, deleteDraft } from '../lib/diaryCache'
import type { CachedEntry, DraftEntry } from '../lib/diaryCache'
import { LocalStorageAdapter } from '../lib/storageAdapter'
import { SyncQueueManager } from '../lib/syncQueue'
import { broadcastMessage } from '../utils/tabSync'
import type { AuthStatus } from './useAuth'
import { shiftDate } from '../utils/date'
import { useLatestRef } from './useEvent'

interface EntryCache {
  meta: DriveFileMeta
  content?: DiaryEntry
  snippet?: string
}

export interface DiaryState {
  loading: boolean
  freshListLoaded: boolean
  error: string | null
  dates: string[]                                      // sorted desc
  hasLegacyMdFiles: boolean                            // any entry still stored as .md (pre-.txt migration)
  getContent: (date: string, options?: { forceNetwork?: boolean; background?: boolean }) => Promise<LoadedDiaryEntry | null>
  save: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  remove: (date: string) => Promise<void>
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

// A fetch that never produced an HTTP response — the device is offline or the
// request failed at the network layer. These edits are kept as local drafts.
function isNetworkFailure(e: unknown): boolean {
  return (typeof navigator !== 'undefined' && !navigator.onLine) || e instanceof TypeError
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
  const onExpiredRef = useLatestRef(onExpired)
  const onEvictedRef = useLatestRef(onEntriesEvicted)

  const storageAdapter = useMemo(() => new LocalStorageAdapter(), [])
  const syncQueue = useMemo(() => new SyncQueueManager(), [])

  const updateCache = useCallback((updater: (prev: Map<string, EntryCache>) => Map<string, EntryCache>) => {
    setCache(prev => {
      const next = updater(prev)
      cacheRef.current = next
      return next
    })
  }, [])

  const loadEntryList = useCallback(async (preserveExistingContent: boolean, syncPersistentCache: boolean): Promise<Map<string, EntryCache>> => {
    const files = await listEntries()

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
        ...toUpsert.map(e => putCached(e).catch(() => {})),
        ...toDelete.map(d => deleteCached(d).catch(() => {})),
      ]).catch(() => {})
    }

    return next
  }, [updateCache])

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
    if (!isSignedIn) return null

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
      try {
        const current = cacheRef.current.get(date)
        const loaded = await getEntryByDate(date, undefined, current?.meta.id)
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
        if (email !== null) putCached({ date, meta, content, snippet: content.content.slice(0, 500) }).catch(() => {})
        return { entry: content, meta }
      } catch (e) {
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
  }, [isSignedIn, email, updateCache, pumpBgQueue])

  // Load entry list when signed in
  useEffect(() => {
    if (!isSignedIn) {
      const empty = new Map<string, EntryCache>()
      setFreshListLoaded(false)
      cacheRef.current = empty
      setCache(empty)
      // Drop queued background fetches — a task starting after sign-out would
      // 401 and wrongly surface the session-expired flow.
      bgQueueRef.current.splice(0).forEach(t => t.cancel())
      // Only wipe the persistent cache once the session is known to be gone;
      // while auth is still restoring ('initializing') the cache must survive
      // so the IDB preload below has data after a reload.
      if (authStatus === 'signedOut') clearCache().catch(() => {})
      return
    }
    setFreshListLoaded(false)
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        // If the signed-in account differs from the last known account, evict IDB
        // before hydrating to prevent one user's diary from briefly appearing to another.
        const canUsePersistentCache = email !== null
        const storedUser = localStorage.getItem('linger_session_user')
        if (!canUsePersistentCache) {
          await clearCache().catch(() => {})
          localStorage.removeItem('linger_session_user')
        } else if (storedUser !== email) {
          await clearCache().catch(() => {})
          localStorage.setItem('linger_session_user', email)
        }

        // Preload from IDB immediately so the sidebar and previously-opened entries
        // appear without waiting for the Drive network round trip.
        const idbEntries = canUsePersistentCache ? await getAllCached().catch(() => [] as CachedEntry[]) : []
        if (idbEntries.length > 0) {
          updateCache(() => {
            const m = new Map<string, EntryCache>()
            for (const e of idbEntries) m.set(e.date, { meta: e.meta, content: e.content, snippet: e.snippet })
            return m
          })
          setLoading(false)
        }
        // Always sync with Drive to pick up remote changes and evict stale content
        const freshCache = await loadEntryList(true, canUsePersistentCache)
        setFreshListLoaded(true)

        // Prefetch the 3 most recent entries that aren't already in memory
        const recentDates = Array.from(freshCache.keys())
          .sort((a, b) => b.localeCompare(a))
          .slice(0, 3)
          .filter(d => !freshCache.get(d)?.content)
        for (const d of recentDates) {
          getContent(d, { background: true }).catch(() => {})
        }
      } catch (e) {
        if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
        console.error('Failed to load diary entries:', e)
        setError(String(e))
        setFreshListLoaded(false)
      } finally {
        setLoading(false)
      }
    })()
  }, [authStatus, isSignedIn, email, loadEntryList, updateCache, getContent])

  const refreshEntries = useCallback(async (): Promise<void> => {
    if (!isSignedIn) return
    try {
      const { changes } = await getChanges()
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
          ...toUpsert.map(e => putCached(e).catch(() => {})),
          ...toDelete.map(d => deleteCached(d).catch(() => {})),
        ]).catch(() => {})
      }
    } catch (e) {
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      throw e
    }
  }, [isSignedIn, email, updateCache])

  const save = useCallback(async (date: string, content: string, baseVersion: string | null, force = false, baseContent?: string | null): Promise<LoadedDiaryEntry> => {
    if (!isSignedIn) throw new Error('Not signed in')

    const prev = saveQueueRef.current.get(date) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(async (): Promise<LoadedDiaryEntry> => {
      const entry: DiaryEntry = { date, content }
      try {
        const cachedMeta = cacheRef.current.get(date)?.meta ?? null
        const meta = await saveEntry(date, entry, { fileId: cachedMeta?.id, baseVersion, baseContent, force })
        updateCache(p => {
          const next = new Map(p)
          next.set(date, { meta, content: entry, snippet: entry.content.slice(0, 500) })
          return next
        })
        if (email !== null) putCached({ date, meta, content: entry, snippet: entry.content.slice(0, 500) }).catch(() => {})
        storageAdapter.saveEntry(date, content).catch(() => {})
        broadcastMessage({ type: 'DIARY_UPDATED', date })
        deleteDraft(date).catch(() => {})
        return { entry, meta }
      } catch (e) {
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
          putDraft({ date, content, baseVersion, baseContent: baseContent ?? null, savedAt: Date.now() }).catch(() => {})
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
  }, [isSignedIn, email, updateCache, storageAdapter, syncQueue])

  const selectedDateRef = useLatestRef(selectedDate)

  const replayingDraftsRef = useRef(false)

  // Push drafts persisted while offline back to Drive. Runs after the initial
  // Drive sync and whenever connectivity returns. The date open in the editor
  // is skipped — the editor owns that draft and retries it itself.
  const replayDrafts = useCallback(async (): Promise<void> => {
    if (!isSignedIn || replayingDraftsRef.current) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    replayingDraftsRef.current = true
    try {
      await syncQueue.process(async (item) => {
        try {
          if (item.type === 'REMOVE') {
            await deleteEntry(item.date)
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
        } catch {
          return false
        }
      }).catch(() => {})

      const drafts = await getAllDrafts().catch(() => [] as DraftEntry[])
      for (const draft of drafts) {
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
          if (e instanceof TokenExpiredError) return
          if (e instanceof EntryConflictError) {
            // Leave resolution to the user in the editor; stop auto-retrying.
            putDraft({ ...draft, conflicted: true }).catch(() => {})
          }
          // Network failures: the draft stays for the next replay.
        }
      }
    } finally {
      replayingDraftsRef.current = false
    }
  }, [isSignedIn, save, syncQueue, storageAdapter, updateCache])

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

  const remove = useCallback(async (date: string): Promise<void> => {
    if (!isSignedIn) throw new Error('Not signed in')
    const existing = cacheRef.current.get(date)
    if (!existing) {
      deleteDraft(date).catch(() => {})
      return
    }
    try {
      await deleteEntry(date)
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
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      if (isNetworkFailure(e)) {
        syncQueue.enqueue({
          id: `remove-${date}-${Date.now()}`,
          type: 'REMOVE',
          date,
          timestamp: Date.now(),
        }).catch(() => {})
      }
      throw e
    }
  }, [isSignedIn, updateCache, storageAdapter, syncQueue])

  const search = useCallback(async (query: string): Promise<SearchResult> => {
    if (!isSignedIn || !query.trim()) return { results: [], unindexedCount: 0, totalCount: 0 }

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
      const files = await searchEntries(query)
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
        try {
          const loaded = await getEntryByDate(date, undefined, fileId)
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

    const results = Array.from(found, ([date, snippet]) => ({ date, snippet }))
    results.sort((a, b) => b.date.localeCompare(a.date))
    const totalCount = results.length + unfetchedMatches
    return { results: results.slice(0, SEARCH_RESULT_LIMIT), unindexedCount: failedCount, totalCount }
  }, [isSignedIn, updateCache])

  const retryPendingSave = useCallback(async (): Promise<LoadedDiaryEntry | null> => {
    const pending = pendingSaveRef.current
    if (!pending) return null
    pendingSaveRef.current = null
    return save(pending.date, pending.content, pending.baseVersion, false, pending.baseContent)
  }, [save])

  const exportAll = useCallback(async (onProgress?: (done: number, total: number) => void): Promise<{ date: string; content: string }[]> => {
    if (!isSignedIn) throw new Error('Not signed in')

    const dates = Array.from(cache.keys()).sort((a, b) => a.localeCompare(b))
    const total = dates.length
    let done = 0
    const results = await mapWithConcurrency(dates, 4, async (date) => {
      const loaded = await getContent(date)
      done += 1
      onProgress?.(done, total)
      const entry = loaded?.entry
      if (!entry) return { date, content: '' }
      return { date, content: entry.content }
    })

    return results
  }, [isSignedIn, cache, getContent])

  // Imports previously-exported entries. Dates that already exist locally (or
  // that the server reports as a conflict, e.g. a stale cache snapshot) are
  // skipped rather than overwritten, so a re-run or a partial migration can
  // never clobber an entry written after the export was taken.
  const importAll = useCallback(async (
    entries: { date: string; content: string }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ImportResult> => {
    if (!isSignedIn) throw new Error('Not signed in')

    const total = entries.length
    let done = 0
    const imported: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    await mapWithConcurrency(entries, 4, async ({ date, content }) => {
      try {
        if (cacheRef.current.has(date)) {
          skipped.push(date)
        } else {
          await save(date, content, null)
          imported.push(date)
        }
      } catch (e) {
        if (e instanceof TokenExpiredError) throw e
        if (e instanceof EntryConflictError) {
          skipped.push(date)
        } else {
          failed.push(date)
        }
      } finally {
        done += 1
        onProgress?.(done, total)
      }
    })

    return { imported, skipped, failed }
  }, [isSignedIn, save])

  // Prefetch a set of dates with bounded concurrency. Skips dates that have no
  // entry or whose content is already loaded; in-flight dedup in getContent
  // prevents racing with other prefetch paths.
  const prefetch = useCallback(async (dates: string[], concurrency = 3): Promise<void> => {
    if (!isSignedIn) return
    const targets = dates.filter(d => cacheRef.current.has(d) && !cacheRef.current.get(d)?.content)
    if (targets.length === 0) return
    await mapWithConcurrency(targets, Math.max(1, concurrency), async (d) => {
      await getContent(d, { background: true }).catch(() => {})
    })
  }, [isSignedIn, getContent])

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

  const dates = useMemo(() => Array.from(cache.keys()).sort((a, b) => b.localeCompare(a)), [cache])
  const hasLegacyMdFiles = useMemo(() => Array.from(cache.values()).some(e => /\.md$/.test(e.meta.name)), [cache])

  return { loading, freshListLoaded, error, dates, hasLegacyMdFiles, getContent, save, remove, search, refreshEntries, prefetch, retryPendingSave, exportAll, importAll }
}
