import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { SearchResult } from '../hooks/useDiary'
import { diaryDateLabel } from '../utils/date'
import { useI18n } from '../i18n'

interface Result {
  date: string
  snippet: string
}

interface Props {
  onSearch: (query: string) => Promise<SearchResult>
  onSelect: (date: string) => void
  entriesLoading: boolean
}

function highlightSnippet(snippet: string, query: string): ReactNode {
  const trimmed = query.trim()
  if (!trimmed) return snippet
  const escaped = trimmed.split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const parts = snippet.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) => i % 2 === 1 ? <mark key={i}>{part}</mark> : part)
}

const SEARCH_DEBOUNCE_MS = 250
const QUERY_MAX_LENGTH = 500
const QUERY_WARN_THRESHOLD = 400

export interface SearchBarHandle {
  focus(): void
}

export const SearchBar = forwardRef<SearchBarHandle, Props>(function SearchBar({ onSearch, onSelect, entriesLoading }, ref) {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [searched, setSearched] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [failedCount, setFailedCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const timerRef = useRef<number | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  }))

  useEffect(() => {
    window.clearTimeout(timerRef.current)
    const trimmed = query.trim()

    if (!trimmed) {
      setResults([])
      setSearched(false)
      setIsSearching(false)
      setFailedCount(0)
      setTotalCount(0)
      return
    }

    if (entriesLoading) {
      setResults([])
      setSearched(false)
      return
    }

    timerRef.current = window.setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsSearching(true)
      try {
        const { results: r, unindexedCount, totalCount: tc } = await onSearch(query)
        if (!controller.signal.aborted) {
          setResults(r)
          setSearched(true)
          setFailedCount(unindexedCount)
          setTotalCount(tc)
        }
      } catch {
        if (!controller.signal.aborted) {
          setResults([])
          setSearched(true)
          setFailedCount(0)
          setTotalCount(0)
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false)
        }
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timerRef.current)
      abortRef.current?.abort()
    }
  }, [entriesLoading, onSearch, query])

  const hasQuery = query.trim().length > 0
  const nearLimit = query.length >= QUERY_WARN_THRESHOLD

  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <svg className="search-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          ref={inputRef}
          type="search"
          placeholder={t.search.placeholder}
          value={query}
          onChange={e => setQuery(e.target.value)}
          maxLength={QUERY_MAX_LENGTH}
          aria-describedby={nearLimit ? 'search-char-count' : undefined}
        />
      </div>
      {nearLimit && (
        <div
          id="search-char-count"
          className={`search-char-count${query.length >= QUERY_MAX_LENGTH ? ' search-char-count--limit' : ''}`}
          aria-live="polite"
        >
          {query.length}/{QUERY_MAX_LENGTH} — {t.search.queryLimit(QUERY_MAX_LENGTH)}
        </div>
      )}
      {isSearching && hasQuery && (
        <div className="search-status" role="status">
          <span className="search-status-spinner" aria-hidden="true" />
          <span>{t.search.searching}</span>
        </div>
      )}
      {entriesLoading && hasQuery && !isSearching && (
        <div className="search-status" role="status">
          <span className="search-status-spinner" aria-hidden="true" />
          <span>{t.search.loadingEntries}</span>
        </div>
      )}
      <AnimatePresence>
        {results.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <div className="search-result-header">
              <span className="search-result-count">{t.search.resultCount(totalCount)}</span>
              {totalCount > results.length && (
                <span className="search-result-capped">{t.search.resultsCapped(results.length, totalCount)}</span>
              )}
            </div>
            <ul className="search-results">
              {results.map(r => (
                <li key={r.date} onClick={() => { onSelect(r.date); setQuery(''); setResults([]); setSearched(false); setFailedCount(0); setTotalCount(0) }}>
                  <span className="search-date">{diaryDateLabel(r.date, true, 'long', locale)}</span>
                  <span className="search-snippet">…{highlightSnippet(r.snippet, query)}…</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
      {searched && hasQuery && !entriesLoading && !isSearching && results.length === 0 && (
        <div className="search-status">{t.search.noResults}</div>
      )}
      {searched && hasQuery && !isSearching && failedCount > 0 && (
        <div className="search-status error" role="status">
          {t.search.partialResults(failedCount)}
        </div>
      )}
    </div>
  )
})
