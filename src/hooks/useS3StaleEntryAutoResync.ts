import { useCallback } from 'react'

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
export function useS3StaleEntryAutoResync(_isSignedIn: boolean, _s3Backfill: S3BackfillTrigger, _blocked: boolean): () => void {
  return useCallback(() => {
    // Auto-starting an account-wide resync on a single entry's unconfirmed status is disabled.
    // Single entries are mirrored individually via mirrorEntrySave. Full resync is triggered
    // explicitly via SettingsModal's "Resync All" button.
  }, [])
}
