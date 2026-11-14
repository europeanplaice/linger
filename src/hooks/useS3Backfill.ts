import { useCallback, useEffect, useState } from 'react'
import type { BackfillProgress } from '../types'
import { continueS3Backfill, loadS3Settings } from '../api/s3Settings'
import { TokenExpiredError } from '../api/driveEntries'

export interface UseS3BackfillResult {
  backfillProgress: BackfillProgress | null
  lastSyncError: string | null
  lastSyncErrorAt: string | null
  backfillActive: boolean
  // Called right after a first-time-enable save, a failed-entries retry, or a full
  // resync kicks off a server-side backfill — starts polling immediately instead of
  // waiting for the next scheduled settings load to notice the new progress record.
  startBackfill: () => void
}

// Drives S3 backfill progress from the open page. Each bounded chunk receives the
// current in-memory Google credentials from this tab; closing/reloading the page
// pauses the run until the user signs in again.
export function useS3Backfill(isSignedIn: boolean, onTokenExpired?: () => void, tokenExpired = false): UseS3BackfillResult {
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const [lastSyncErrorAt, setLastSyncErrorAt] = useState<string | null>(null)
  const [backupEnabled, setBackupEnabled] = useState(false)
  // Set right after a backfill-starting action, before the server has had a chance to
  // write the first backfillProgress record — keeps polling started even though
  // backfillProgress is still null at that point. Cleared once any poll response arrives.
  const [expectingBackfill, setExpectingBackfill] = useState(false)

  useEffect(() => {
    if (!isSignedIn || tokenExpired) return
    let cancelled = false
    loadS3Settings().then(settings => {
      if (cancelled || !settings) return
      setBackupEnabled(settings.enabled)
      setLastSyncError(settings.lastSyncError ?? null)
      setLastSyncErrorAt(settings.lastSyncErrorAt ?? null)
      setBackfillProgress(settings.backfillProgress ?? null)
    }).catch(e => {
      if (e instanceof TokenExpiredError) onTokenExpired?.()
      else console.error('Failed to load S3 backfill state:', e)
    })
    return () => { cancelled = true }
  }, [isSignedIn, tokenExpired])

  const startBackfill = useCallback(() => {
    setBackfillProgress(null)
    setExpectingBackfill(true)
  }, [])

  const backfillActive = isSignedIn && !tokenExpired && (expectingBackfill || (backupEnabled && backfillProgress !== null && !backfillProgress.finishedAt))
  useEffect(() => {
    if (!backfillActive) return
    let cancelled = false
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const settings = await loadS3Settings()
        if (cancelled) return
        setBackupEnabled(settings?.enabled ?? false)
        setLastSyncError(settings?.lastSyncError ?? null)
        setLastSyncErrorAt(settings?.lastSyncErrorAt ?? null)
        setBackfillProgress(settings?.backfillProgress ?? null)
        setExpectingBackfill(false)
        if (settings?.enabled && settings.backfillProgress && !settings.backfillProgress.finishedAt) {
          await continueS3Backfill()
        }
      } catch (e) {
        if (!cancelled && e instanceof TokenExpiredError) onTokenExpired?.()
        else if (!cancelled) console.error('Failed to advance S3 backfill:', e)
      } finally {
        polling = false
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backfillActive, onTokenExpired])

  return { backfillProgress, lastSyncError, lastSyncErrorAt, backfillActive, startBackfill }
}
