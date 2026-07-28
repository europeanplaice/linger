import { useCallback, useEffect, useRef } from 'react'
import { resyncS3Backfill } from '../api/s3Settings'

export interface S3BackfillTrigger {
  backfillActive: boolean
  startBackfill: () => void
}

// Fires an account-wide S3 resync at most once per session, the first time a
// plain-open entry-status poll reports 'unconfirmed' (see EntryEditor's
// onS3StaleEntryDetected) — the strongest signal that this account has entries
// that were never backfilled at all, as opposed to one save's mirror running
// behind. Silently kicking a full resync fixes every such date in one chunked,
// resumable run instead of only offering a per-entry manual retry.
//
// `blocked` should be true whenever something else might concurrently rewrite
// s3_settings.json — e.g. the Settings modal's own Save/Test/Resync actions
// (see SettingsModal.tsx) have no concurrency check against each other.
export function useS3StaleEntryAutoResync(isSignedIn: boolean, s3Backfill: S3BackfillTrigger, blocked: boolean): () => void {
  const triggeredRef = useRef(false)

  useEffect(() => {
    if (!isSignedIn) triggeredRef.current = false
  }, [isSignedIn])

  return useCallback(() => {
    if (triggeredRef.current || s3Backfill.backfillActive || blocked) return
    // Set before the request settles, and never reset on failure: this is
    // meant to fire at most once per session, full stop — a persistently
    // failing resync (e.g. a broken IAM role) must not refire on every stale
    // date the user happens to open this session, same as a failed per-entry
    // auto-retry (see pollS3Status in EntryEditor.tsx) still leaves the user
    // with a terminal, tappable badge rather than looping.
    triggeredRef.current = true
    resyncS3Backfill().then(() => s3Backfill.startBackfill()).catch(e => {
      console.error('Failed to auto-start S3 resync:', e)
    })
  }, [s3Backfill, blocked])
}
