import { useCallback, useEffect, useRef } from 'react'
import { useLatestRef } from './useEvent'

const AUTO_SAVE_MS = 1500
// Even while the user keeps typing (which resets the debounce), persist at least
// this often so a long uninterrupted writing session is never left unsaved.
const AUTO_SAVE_MAX_WAIT_MS = 10000

interface AutoSaveOptions {
  enabled: boolean
  isDirty: boolean
  // Re-runs the idle debounce on every change; pass the editor text.
  text: string
  // Persist the current edits silently; the boolean marks this as a non-explicit save.
  save: (explicit: boolean) => Promise<boolean>
  // Whether a silent save may run right now — not already saving, no conflict,
  // not loading/failed, and there are unsaved edits. Must read fresh state.
  canSave: () => boolean
}

// Silent auto-save: a debounced idle save capped at a maximum wait, plus an
// immediate flush on blur / tab-hide / unmount so the idle window can't drop the
// last keystrokes. Returns `flush` to wire to the textarea's blur handler.
export function useAutoSave({ enabled, isDirty, text, save, canSave }: AutoSaveOptions) {
  const saveRef = useLatestRef(save)
  const canSaveRef = useLatestRef(canSave)

  // Persist pending edits now, bypassing the debounce.
  const flush = useCallback(() => {
    if (!enabled) return
    if (!canSaveRef.current()) return
    void saveRef.current(false)
  }, [enabled, saveRef, canSaveRef])

  // Tracks when the current unsaved streak began. Unlike the debounce timer it is
  // NOT reset by each keystroke, so it can cap the maximum time before a save.
  const dirtyStreakStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !isDirty) {
      dirtyStreakStartRef.current = null
      return
    }
    if (dirtyStreakStartRef.current === null) dirtyStreakStartRef.current = Date.now()
    const elapsed = Date.now() - dirtyStreakStartRef.current
    const wait = Math.max(0, Math.min(AUTO_SAVE_MS, AUTO_SAVE_MAX_WAIT_MS - elapsed))
    const id = window.setTimeout(() => {
      if (!canSaveRef.current()) return
      // Open a fresh max-wait window from this save. Without this, once elapsed
      // passes AUTO_SAVE_MAX_WAIT_MS an uninterrupted typing session that keeps
      // overlapping in-flight saves would re-fire a save on nearly every
      // keystroke instead of at most once per window.
      dirtyStreakStartRef.current = Date.now()
      void saveRef.current(false)
    }, wait)
    return () => window.clearTimeout(id)
  }, [enabled, isDirty, text, saveRef, canSaveRef])

  // Flush when the tab is hidden or torn down. On mobile visibilitychange/pagehide
  // are the only reliable "leaving" signals (beforeunload often doesn't fire), so
  // these guard against losing edits made in the last moment.
  useEffect(() => {
    if (!enabled) return
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [enabled, flush])

  return flush
}
