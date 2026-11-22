import { useCallback, useEffect, useRef } from 'react'
import { useLatestRef } from './useEvent'

export const AUTO_SAVE_MS = 2500
// Even while the user keeps typing (which resets the debounce), persist to
// Drive at least this often so a long uninterrupted writing session is synced
// regularly (local encrypted recovery drafts already checkpoint every 350ms).
export const AUTO_SAVE_MAX_WAIT_MS = 30_000
export const AUTO_SAVE_RETRY_BASE_MS = 5000
export const AUTO_SAVE_RETRY_MAX_MS = 60_000

export interface AutoSaveSaveOptions {
  keepalive?: boolean
}

interface AutoSaveOptions {
  enabled: boolean
  isDirty: boolean
  // Pause cloud save attempts while offline so we don't spin a failing retry
  // loop or flicker UI status; local drafts protect offline edits instead.
  isOnline?: boolean
  // Hold cloud saves while an IME composition (e.g. Japanese kana-kanji
  // conversion) is active so uncommitted text isn't written as a revision.
  isComposing?: boolean
  // Pass the latest saved text (or a save counter) so edits typed during an
  // in-flight save trigger a prompt idle debounce once that save succeeds.
  savedText?: string
  // Re-runs the idle debounce on every change; pass the editor text.
  text: string
  // Persist the current edits silently; the boolean marks this as a non-explicit save.
  save: (explicit: boolean, options?: AutoSaveSaveOptions) => Promise<boolean>
  // Whether a silent save may run right now — not already saving, no conflict,
  // not paused, not loading/failed, not composing, and there are unsaved edits.
  // Must read fresh state.
  canSave: () => boolean
}

function retryBackoffMs(failureCount: number): number {
  return Math.min(AUTO_SAVE_RETRY_BASE_MS * 2 ** Math.max(0, failureCount - 1), AUTO_SAVE_RETRY_MAX_MS)
}

// Silent auto-save: a debounced idle save capped at a maximum wait, exponential
// backoff on consecutive failures, IME/offline awareness, plus an immediate
// flush on blur / tab-hide / unmount so the idle window can't drop the last
// keystrokes. Returns `flush` to wire to the textarea's blur handler.
export function useAutoSave({
  enabled,
  isDirty,
  isOnline = true,
  isComposing = false,
  savedText,
  text,
  save,
  canSave,
}: AutoSaveOptions) {
  const saveRef = useLatestRef(save)
  const canSaveRef = useLatestRef(canSave)
  const isOnlineRef = useLatestRef(isOnline)
  const isComposingRef = useLatestRef(isComposing)
  const latestTextRef = useLatestRef(text)

  const flushWithOptions = useCallback((options?: AutoSaveSaveOptions) => {
    if (!enabled || !isOnlineRef.current || isComposingRef.current) return
    if (!canSaveRef.current()) return
    void saveRef.current(false, options)
  }, [enabled, isOnlineRef, isComposingRef, saveRef, canSaveRef])

  // Persist pending edits now, bypassing the debounce.
  const flush = useCallback(() => {
    flushWithOptions()
  }, [flushWithOptions])

  // Tracks when the current unsaved streak began. Unlike the debounce timer it is
  // NOT reset by each keystroke, so it can cap the maximum time before a save.
  const dirtyStreakStartRef = useRef<number | null>(null)
  const failureCountRef = useRef(0)
  const lastTextRef = useRef(text)

  useEffect(() => {
    if (!enabled || !isDirty) {
      dirtyStreakStartRef.current = null
      failureCountRef.current = 0
      lastTextRef.current = text
      return
    }
    if (text !== lastTextRef.current) {
      lastTextRef.current = text
      failureCountRef.current = 0
    }
    if (!isOnline) {
      failureCountRef.current = 0
      return
    }
    if (isComposing) return

    if (dirtyStreakStartRef.current === null) dirtyStreakStartRef.current = Date.now()
    const elapsed = Date.now() - dirtyStreakStartRef.current
    const wait = Math.max(0, Math.min(AUTO_SAVE_MS, AUTO_SAVE_MAX_WAIT_MS - elapsed))
    let cancelled = false
    let id: number
    const attempt = async () => {
      if (!isOnlineRef.current || isComposingRef.current) return
      if (!canSaveRef.current()) {
        if (!cancelled) id = window.setTimeout(attempt, AUTO_SAVE_RETRY_BASE_MS)
        return
      }
      // Open a fresh max-wait window from this save. Without this, once elapsed
      // passes AUTO_SAVE_MAX_WAIT_MS an uninterrupted typing session that keeps
      // overlapping in-flight saves would re-fire a save on nearly every
      // keystroke instead of at most once per window.
      const textAtStart = latestTextRef.current
      dirtyStreakStartRef.current = Date.now()
      const ok = await saveRef.current(false)
      if (ok) {
        failureCountRef.current = 0
      } else if (latestTextRef.current === textAtStart) {
        failureCountRef.current += 1
      }
      if (cancelled || !isOnlineRef.current || isComposingRef.current) return
      // A failed save retries with exponential backoff; edits made during an
      // in-flight successful save retry on the normal idle cadence instead of
      // waiting for the slower failure backoff.
      if (ok) {
        if (canSaveRef.current()) id = window.setTimeout(attempt, AUTO_SAVE_MS)
      } else {
        id = window.setTimeout(attempt, retryBackoffMs(failureCountRef.current))
      }
    }
    id = window.setTimeout(attempt, wait)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [enabled, isDirty, isOnline, isComposing, savedText, text, saveRef, canSaveRef, isOnlineRef, isComposingRef, latestTextRef])

  // Flush when the tab is hidden or torn down. On mobile visibilitychange/pagehide
  // are the only reliable "leaving" signals (beforeunload often doesn't fire), so
  // these guard against losing edits made in the last moment. Use keepalive so
  // the browser can finish the request even as the page enters BFCache/unloads.
  useEffect(() => {
    if (!enabled) return
    const flushKeepalive = () => flushWithOptions({ keepalive: true })
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushKeepalive() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushKeepalive)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushKeepalive)
      flushWithOptions()
    }
  }, [enabled, flushWithOptions])

  return flush
}
