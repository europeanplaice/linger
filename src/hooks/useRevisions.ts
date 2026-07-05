import { useState, useEffect, useRef, useCallback } from 'react'
import type { DriveRevisionMeta, LoadedDiaryEntry, DiaryEntry } from '../types'
import { listRevisions, getRevisionContent } from '../api/driveRevisions'
import { TokenExpiredError } from '../api/driveEntries'
import { EntryConflictError } from './useDiary'
import { escapeHtml } from '../utils/escapeHtml'

const UNSAVED_ID = '__unsaved__'

// On open, eagerly fetch content for the most recent revisions so switching
// versions and rendering diffs is instant. Capped to avoid hammering Drive.
const PREFETCH_LIMIT = 50
const PREFETCH_CONCURRENCY = 6

async function prefetchContents(
  fileId: string,
  ids: string[],
  cache: Map<string, DiaryEntry>,
  isCancelled: () => boolean,
): Promise<void> {
  let cursor = 0
  async function worker() {
    while (cursor < ids.length && !isCancelled()) {
      const id = ids[cursor++]
      if (cache.has(id)) continue
      try {
        const content = await getRevisionContent(fileId, id)
        if (isCancelled()) return
        cache.set(id, content)
      } catch {
        // Ignore prefetch failures; selecting the revision will retry and surface errors.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, ids.length) }, worker),
  )
}

export interface RevisionsState {
  revisions: DriveRevisionMeta[]
  showUnsavedEntry: boolean
  listLoading: boolean
  listError: string | null
  selectedId: string | null
  previewContent: string | null
  previewLoading: boolean
  previewError: string | null
  diffHtml: string | null
  restoring: boolean
  restoreError: string | null
  selectRevision: (id: string) => void
  restore: () => Promise<void>
}

interface Params {
  fileId: string
  date: string
  baseVersion: string | null
  text: string
  savedText: string
  isDirty: boolean
  autoSave: boolean
  onSave: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  onRestored: (result: LoadedDiaryEntry) => void
  onExpired: () => void
  messages?: {
    failedToLoadHistory: string
    failedToLoadVersion: string
    restoreConflict: string
    restoreFailed: string
  }
}

const DEFAULT_MESSAGES = {
  failedToLoadHistory: '履歴を読み込めませんでした。',
  failedToLoadVersion: 'このバージョンを読み込めませんでした。',
  restoreConflict: '復元できませんでした。日記が変更されています。先に保存してください。',
  restoreFailed: '復元に失敗しました。',
}

function escapeDiffHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>')
}

async function buildDiffHtml(previous: string, current: string): Promise<string> {
  const Diff = await import('diff')
  return Diff.diffWords(previous, current).map(part => {
    const escaped = escapeDiffHtml(part.value)
    if (part.added) return `<span class="diff-add-word">${escaped}</span>`
    if (part.removed) return `<span class="diff-remove-word">${escaped}</span>`
    return escaped
  }).join('')
}

export function useRevisions({ fileId, date, baseVersion, text, savedText, isDirty, autoSave, onSave, onRestored, onExpired, messages = DEFAULT_MESSAGES }: Params): RevisionsState {
  const showUnsavedEntry = !autoSave && isDirty

  const [revisions, setRevisions] = useState<DriveRevisionMeta[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [diffHtml, setDiffHtml] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const previewAbortRef = useRef<AbortController | null>(null)
  const contentCacheRef = useRef<Map<string, DiaryEntry>>(new Map())
  const onExpiredRef = useRef(onExpired)
  useEffect(() => { onExpiredRef.current = onExpired }, [onExpired])

  useEffect(() => {
    let cancelled = false
    contentCacheRef.current = new Map()
    setListLoading(true)
    setListError(null)
    listRevisions(fileId).then(list => {
      if (cancelled) return
      setRevisions(list)
      if (showUnsavedEntry) {
        setSelectedId(UNSAVED_ID)
      } else if (list.length > 0) {
        setSelectedId(list[0].id)
      }
      void prefetchContents(
        fileId,
        list.slice(0, PREFETCH_LIMIT).map(r => r.id),
        contentCacheRef.current,
        () => cancelled,
      )
    }).catch(e => {
      if (cancelled) return
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      setListError(messages.failedToLoadHistory)
    }).finally(() => {
      if (!cancelled) setListLoading(false)
    })
    return () => { cancelled = true }
  }, [fileId, showUnsavedEntry, messages.failedToLoadHistory])

  useEffect(() => {
    if (!selectedId) return

    if (selectedId === UNSAVED_ID) {
      let cancelled = false
      setPreviewLoading(false)
      setPreviewError(null)
      setPreviewContent(text)
      buildDiffHtml(savedText, text)
        .then(html => {
          if (!cancelled) setDiffHtml(html)
        })
        .catch(() => {
          if (!cancelled) setDiffHtml(null)
        })
      return () => { cancelled = true }
    }

    const idx = revisions.findIndex(r => r.id === selectedId)
    if (idx === -1) return

    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller

    const cache = contentCacheRef.current
    const loadContent = (id: string): Promise<DiaryEntry> => {
      const cached = cache.get(id)
      if (cached) return Promise.resolve(cached)
      return getRevisionContent(fileId, id).then(c => { cache.set(id, c); return c })
    }

    // Skip the loading state when content was prefetched — switching is instant.
    setPreviewLoading(!cache.has(selectedId))
    setPreviewError(null)
    setDiffHtml(null)

    const currentPromise = loadContent(selectedId)
    const prevId = idx < revisions.length - 1 ? revisions[idx + 1].id : null
    const prevPromise = prevId ? loadContent(prevId).catch(() => null) : null

    currentPromise.then(async (current) => {
      if (controller.signal.aborted) return
      const currentContent = current.content
      setPreviewContent(currentContent)

      if (prevPromise) {
        try {
          const prev = await prevPromise
          if (!prev) {
            setDiffHtml(null)
            return
          }
          if (controller.signal.aborted) return

          const html = await buildDiffHtml(prev.content, currentContent)
          if (controller.signal.aborted) return
          setDiffHtml(html)
        } catch {
          setDiffHtml(null)
        }
      }
    }).catch(e => {
      if (controller.signal.aborted) return
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      setPreviewError(messages.failedToLoadVersion)
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false)
    })
    return () => { controller.abort() }
  }, [fileId, selectedId, revisions, text, savedText, messages.failedToLoadVersion])

  const selectRevision = useCallback((id: string) => {
    setSelectedId(id)
    setRestoreError(null)
  }, [])

  const restore = useCallback(async () => {
    if (!previewContent) return
    setRestoring(true)
    setRestoreError(null)
    try {
      const result = await onSave(date, previewContent, baseVersion, undefined, savedText)
      onRestored(result)
    } catch (e) {
      if (e instanceof TokenExpiredError) { onExpiredRef.current(); return }
      if (e instanceof EntryConflictError) {
        setRestoreError(messages.restoreConflict)
      } else {
        setRestoreError(messages.restoreFailed)
      }
    } finally {
      setRestoring(false)
    }
  }, [previewContent, date, baseVersion, savedText, onSave, onRestored, messages.restoreConflict, messages.restoreFailed])

  return {
    revisions,
    showUnsavedEntry,
    listLoading,
    listError,
    selectedId,
    previewContent,
    previewLoading,
    previewError,
    diffHtml,
    restoring,
    restoreError,
    selectRevision,
    restore,
  }
}
