import { useState, useEffect, useCallback, useRef } from 'react'
import type { DiaryEntry, DriveFileMeta, LoadedDiaryEntry } from '../types'
import { listEntries, searchEntries, getEntryByDate, saveEntry, deleteEntry, getChanges, TokenExpiredError, SaveConflictError } from '../api/driveEntries'
import { getAllCached, putCached, deleteCached, clearCache } from '../lib/diaryCache'
import type { CachedEntry } from '../lib/diaryCache'
import { shiftDate } from '../utils/date'

interface EntryCache {
  meta: DriveFileMeta
  content?: DiaryEntry
  snippet?: string
}

export interface DiaryState {
  loading: boolean
  error: string | null
  dates: string[]                                      // sorted desc
  hasLegacyMdFiles: boolean                            // any entry still stored as .md (pre-.txt migration)
  getContent: (date: string, options?: { forceNetwork?: boolean }) => Promise<LoadedDiaryEntry | null>
  save: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  remove: (date: string) => Promise<void>
  search: (query: string) => Promise<SearchResult>
  refreshEntries: () => Promise<void>
  retryPendingSave: () => Promise<LoadedDiaryEntry | null>
  exportAll: (format: 'txt' | 'md', onProgress?: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
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

export function useDiary(isSignedIn: boolean, email: string | null, onExpired: () => void, onEntriesEvicted?: (dates: string[]) => void, selectedDate?: string): DiaryState {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cache, setCache] = useState<Map<string, EntryCache>>(new Map())
  const cacheRef = useRef(cache)
  const saveQueueRef = useRef<Map<string, Promise<unknown>>>(new Map())
  const pendingSaveRef = useRef<PendingSave | null>(null)
  const onExpiredRef = useRef(onExpired)
  const onEvictedRef = useRef(onEntriesEvicted)
  useEffect(() => { onExpiredRef.current = onExpired })
  useEffect(() => { onEvictedRef.current = onEntriesEvicted })
  useEffect(() => { cacheRef.current = cache }, [cache])

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

  const getContent = useCallback(async (date: string, options: { forceNetwork?: boolean } = {}): Promise<LoadedDiaryEntry | null> => {
    if (!isSignedIn) return null
    try {
      const cached = cacheRef.current.get(date)

      // Content is already in memory (verified by listEntries version check or saved this session)
      if (cached?.content && !options.forceNetwork) return { entry: cached.content, meta: cached.meta }

      const loaded = await getEntryByDate(date, undefined, cached?.meta.id)
      if (!loaded || loaded === 'not-modified') {
        if (options.forceNetwork && cached) {
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
  }, [isSignedIn, email, updateCache])

  // Load entry list when signed in
  useEffect(() => {
    if (!isSignedIn) {
      const empty = new Map<string, EntryCache>()
      cacheRef.current = empty
      setCache(empty)
      clearCache().catch(() => {})
      return
    }
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

        // Prefetch the 3 most recent entries that aren't already in memory
        const recentDates = Array.from(freshCache.keys())
          .sort((a, b) => b.localeCompare(a))
          .slice(0, 3)
          .filter(d => !freshCache.get(d)?.content)
        for (const d of recentDates) {
          getContent(d).catch(() => {})
        }
      } catch (e) {
        if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
        console.error('Failed to load diary entries:', e)
        setError(String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [isSignedIn, email, loadEntryList, updateCache, getContent])

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
        return { entry, meta }
      } catch (e) {
        if (e instanceof TokenExpiredError) {
          pendingSaveRef.current = { date, content, baseVersion, baseContent }
          onExpiredRef.current()
          throw e
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
  }, [isSignedIn, email, updateCache])

  const remove = useCallback(async (date: string): Promise<void> => {
    if (!isSignedIn) throw new Error('Not signed in')
    const existing = cacheRef.current.get(date)
    if (!existing) return
    try {
      await deleteEntry(date)
      updateCache(prev => {
        const next = new Map(prev)
        next.delete(date)
        return next
      })
      deleteCached(date).catch(() => {})
    } catch (e) {
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      throw e
    }
  }, [isSignedIn, updateCache])

  const search = useCallback(async (query: string): Promise<SearchResult> => {
    if (!isSignedIn || !query.trim()) return { results: [], unindexedCount: 0, totalCount: 0 }

    const files = await searchEntries(query)
    const cached = cacheRef.current
    const normalizedQuery = query.toLowerCase()
    const candidates = files
      .map(f => ({ date: f.name.replace('diary-', '').replace(/\.(json|md|txt)$/, ''), fileId: f.id }))
      .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date))

    const totalCount = candidates.length
    candidates.sort((a, b) => b.date.localeCompare(a.date))
    const limited = candidates.slice(0, 30)

    let failedCount = 0
    const mapped = await mapWithConcurrency(limited, 5, async ({ date, fileId }) => {
      const cachedEntry = cached.get(date)
      if (cachedEntry?.content) {
        const text = cachedEntry.content.content
        const idx = text.toLowerCase().indexOf(normalizedQuery)
        const snippet = text.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ')
        return { date, snippet }
      }

      try {
        const loaded = await getEntryByDate(date, undefined, fileId)
        if (!loaded || loaded === 'not-modified') return null
        const text = loaded.entry.content
        const idx = text.toLowerCase().indexOf(normalizedQuery)
        const snippet = text.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ')
        updateCache(prev => {
          const next = new Map(prev)
          const ex = next.get(date)
          if (ex) next.set(date, { ...ex, content: loaded.entry, snippet })
          return next
        })
        return { date, snippet }
      } catch {
        failedCount++
        return null
      }
    })

    const results = mapped.filter((r): r is { date: string; snippet: string } => r !== null)
    results.sort((a, b) => b.date.localeCompare(a.date))
    return { results, unindexedCount: failedCount, totalCount }
  }, [isSignedIn, updateCache])

  const retryPendingSave = useCallback(async (): Promise<LoadedDiaryEntry | null> => {
    const pending = pendingSaveRef.current
    if (!pending) return null
    pendingSaveRef.current = null
    return save(pending.date, pending.content, pending.baseVersion, false, pending.baseContent)
  }, [save])

  const exportAll = useCallback(async (format: 'txt' | 'md', onProgress?: (done: number, total: number) => void): Promise<{ date: string; content: string }[]> => {
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
      const content = format === 'md'
        ? `---\ndate: ${entry.date}\n---\n\n${entry.content}`
        : entry.content
      return { date, content }
    })

    return results
  }, [isSignedIn, cache, getContent])

  const getContentRef = useRef(getContent)
  useEffect(() => { getContentRef.current = getContent }, [getContent])

  useEffect(() => {
    if (!selectedDate) return
    const id = setTimeout(() => {
      ;[shiftDate(selectedDate, -1), shiftDate(selectedDate, 1)]
        .filter(d => cacheRef.current.has(d) && !cacheRef.current.get(d)?.content)
        .forEach(d => getContentRef.current(d).catch(() => {}))
    }, 300)
    return () => clearTimeout(id)
  }, [selectedDate])

  const dates = Array.from(cache.keys()).sort((a, b) => b.localeCompare(a))
  const hasLegacyMdFiles = Array.from(cache.values()).some(e => /\.md$/.test(e.meta.name))

  return { loading, error, dates, hasLegacyMdFiles, getContent, save, remove, search, refreshEntries, retryPendingSave, exportAll }
}
