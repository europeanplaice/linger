import { useCallback, useEffect, useState } from 'react'
import type { BackfillProgress } from '../types'
import { loadS3Settings } from '../api/s3Settings'

export interface UseS3BackfillResult {
  backfillProgress: BackfillProgress | null
  lastSyncError: string | null
  lastSyncErrorAt: string | null
  backfillActive: boolean
  // Called right after a first-time-enable save, a failed-entries retry, or a full
  // resync kicks off a server-side backfill — starts polling immediately instead of
  // waiting for the next scheduled settings load to notice the new progress record.
  startBackfill: () => void
  // Called right after a plain settings save — saving rewrites the whole settings
  // file without sync-status fields, so the stored error is cleared server-side too;
  // this mirrors that locally right away instead of waiting for the next poll.
  clearSyncError: () => void
}

// Drives S3 backfill progress from the top of the app (not from inside the Settings
// modal) so a running backfill keeps advancing even while Settings is closed — only
// closing the tab/app itself stops it. Workflows continue independently of this
// poller; the browser only reads the Durable Object-backed job snapshot.
export function useS3Backfill(isSignedIn: boolean): UseS3BackfillResult {
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const [lastSyncErrorAt, setLastSyncErrorAt] = useState<string | null>(null)
  // Set right after a backfill-starting action, before the server has had a chance to
  // write the first backfillProgress record — keeps polling started even though
  // backfillProgress is still null at that point. Cleared once any poll response arrives.
  const [expectingBackfill, setExpectingBackfill] = useState(false)

  useEffect(() => {
    if (!isSignedIn) return
    let cancelled = false
    loadS3Settings().then(settings => {
      if (cancelled || !settings) return
      setLastSyncError(settings.lastSyncError ?? null)
      setLastSyncErrorAt(settings.lastSyncErrorAt ?? null)
      setBackfillProgress(settings.backfillProgress ?? null)
    }).catch(e => console.error('Failed to load S3 backfill state:', e))
    return () => { cancelled = true }
  }, [isSignedIn])

  const startBackfill = useCallback(() => {
    setBackfillProgress(null)
    setExpectingBackfill(true)
  }, [])

  const clearSyncError = useCallback(() => {
    setLastSyncError(null)
    setLastSyncErrorAt(null)
  }, [])

  const backfillActive = isSignedIn && (expectingBackfill || (backfillProgress !== null && !backfillProgress.finishedAt))
  useEffect(() => {
    if (!backfillActive) return
    let cancelled = false
    const poll = () => {
      loadS3Settings().then(settings => {
        if (cancelled || !settings) return
        setLastSyncError(settings.lastSyncError ?? null)
        setLastSyncErrorAt(settings.lastSyncErrorAt ?? null)
        // The job is visible as soon as the start RPC succeeds, even while it is
        // still queued and before the first entry is processed.
        if (settings.backfillProgress) {
          setBackfillProgress(settings.backfillProgress)
          setExpectingBackfill(false)
        }
      }).catch(e => console.error('Failed to poll S3 backfill progress:', e))
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backfillActive])

  return { backfillProgress, lastSyncError, lastSyncErrorAt, backfillActive, startBackfill, clearSyncError }
}
