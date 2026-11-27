import { useCallback, useEffect, useRef, useState } from 'react'
import { getAllCached } from '../lib/secureCache'
import { buildIndex, updateIndex, search, findSimilar, sharedTokens, type TfIdfDoc, type TfIdfIndex } from '../utils/tfidf'
import { findRecurringAbsentTopic, type RecurringTopic } from '../utils/topicExtraction'
import type { Language } from '../i18n'

export interface LocalSearchResult {
  date: string
  snippet: string
}

interface WorkerBuildResponse {
  generation: number
  index: TfIdfIndex
}

function buildIndexInWorker(
  docs: TfIdfDoc[],
  generation: number,
  isCancelled: () => boolean,
): Promise<TfIdfIndex | null> {
  if (typeof Worker === 'undefined' || import.meta.env.MODE === 'test') {
    return Promise.resolve(buildIndex(docs))
  }

  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../utils/tfidf.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      resolve(buildIndex(docs))
      return
    }

    const cleanup = () => {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }

    worker.onmessage = (event: MessageEvent<WorkerBuildResponse>) => {
      cleanup()
      if (isCancelled() || event.data.generation !== generation) {
        resolve(null)
        return
      }
      resolve(event.data.index)
    }

    worker.onerror = () => {
      cleanup()
      if (isCancelled()) {
        resolve(null)
        return
      }
      resolve(buildIndex(docs))
    }

    worker.postMessage({ generation, docs })
  })
}

export function useTfIdfSearch(owner: string | null = null) {
  const [ready, setReady] = useState(false)
  const [indexVersion, setIndexVersion] = useState(0)
  const indexRef = useRef<TfIdfIndex | null>(null)
  const overridesRef = useRef<Map<string, string>>(new Map())
  const rebuildGenerationRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const generation = ++rebuildGenerationRef.current

    indexRef.current = null
    overridesRef.current = new Map()
    setReady(false)
    if (!owner) return () => { cancelled = true; rebuildGenerationRef.current++ }

    const isStale = () => cancelled || generation !== rebuildGenerationRef.current

    getAllCached()
      .then(async (entries) => {
        if (isStale()) return
        const docMap = new Map<string, string>()
        for (const e of entries) {
          if (e.content?.content) docMap.set(e.date, e.content.content)
        }
        // Preserve any updates that arrived while the initial cache load was in flight.
        for (const [date, content] of overridesRef.current) {
          docMap.set(date, content)
        }
        const docs: TfIdfDoc[] = Array.from(docMap, ([date, content]) => ({ date, content }))
        const built = await buildIndexInWorker(docs, generation, isStale)
        if (!built || isStale()) return

        // Merge any updates that arrived while the worker was building the index.
        let merged = built
        for (const [date, content] of overridesRef.current) {
          if (merged.contents.get(date) !== content) {
            merged = updateIndex(merged, date, content)
          }
        }
        indexRef.current = merged
        setReady(true)
        setIndexVersion(v => v + 1)
      })
      .catch(() => {
        // IndexedDB unavailable — feature silently disabled
      })

    return () => { cancelled = true; rebuildGenerationRef.current++ }
  }, [owner])

  const updateEntry = useCallback((date: string, content: string) => {
    overridesRef.current.set(date, content)
    indexRef.current = updateIndex(indexRef.current ?? buildIndex([]), date, content)
    setReady(true)
    setIndexVersion(v => v + 1)
  }, [])

  const searchLocal = useCallback((query: string, limit = 20): LocalSearchResult[] => {
    const idx = indexRef.current
    if (!idx) return []
    return search(idx, query, limit).map(h => ({ date: h.date, snippet: h.snippet }))
  }, [])

  const getSimilar = useCallback((date: string, limit = 3): string[] => {
    const idx = indexRef.current
    if (!idx) return []
    return findSimilar(idx, date, limit)
  }, [])

  const getSharedTokens = useCallback((date1: string, date2: string, limit = 8): string[] => {
    const idx = indexRef.current
    if (!idx) return []
    return sharedTokens(idx, date1, date2, limit)
  }, [])

  const hasEntry = useCallback((date: string): boolean => {
    return indexRef.current?.vectors.has(date) ?? false
  }, [])

  const getRecurringTopic = useCallback((date: string, language: Language, windowDays = 14): RecurringTopic | null => {
    const idx = indexRef.current
    if (!idx) return null
    return findRecurringAbsentTopic(idx.contents, date, windowDays, language)
  }, [])

  return { ready, indexVersion, searchLocal, getSimilar, getSharedTokens, updateEntry, hasEntry, getRecurringTopic }
}
