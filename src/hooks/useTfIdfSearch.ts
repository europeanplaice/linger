import { useCallback, useEffect, useRef, useState } from 'react'
import { getAllCached } from '../lib/diaryCache'
import { buildIndex, search, findSimilar, type TfIdfDoc, type TfIdfIndex } from '../utils/tfidf'

export interface LocalSearchResult {
  date: string
  snippet: string
}

export function useTfIdfSearch() {
  const [ready, setReady] = useState(false)
  const [indexVersion, setIndexVersion] = useState(0)
  const indexRef = useRef<TfIdfIndex | null>(null)

  useEffect(() => {
    let cancelled = false

    getAllCached()
      .then(entries => {
        if (cancelled) return
        const docs: TfIdfDoc[] = entries
          .filter(e => e.content?.content)
          .map(e => ({ date: e.date, content: e.content!.content }))
        indexRef.current = buildIndex(docs)
        setReady(true)
        setIndexVersion(v => v + 1)
      })
      .catch(() => {
        // IndexedDB unavailable — feature silently disabled
      })

    return () => { cancelled = true }
  }, [])

  const rebuildGenerationRef = useRef(0)

  const rebuildFromCache = useCallback((overrides: Record<string, string> = {}) => {
    const generation = ++rebuildGenerationRef.current
    getAllCached()
      .then(entries => {
        if (generation !== rebuildGenerationRef.current) return
        const docs: TfIdfDoc[] = entries
          .filter(e => e.content?.content)
          .map(e => ({
            date: e.date,
            content: overrides[e.date] ?? e.content!.content,
          }))
        for (const [date, content] of Object.entries(overrides)) {
          if (!docs.find(d => d.date === date)) docs.push({ date, content })
        }
        indexRef.current = buildIndex(docs)
        setIndexVersion(v => v + 1)
      })
      .catch(() => {})
  }, [])

  const updateEntry = useCallback((date: string, content: string) => {
    rebuildFromCache({ [date]: content })
  }, [rebuildFromCache])

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

  return { ready, indexVersion, searchLocal, getSimilar, updateEntry }
}
