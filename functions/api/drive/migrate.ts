import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { migrateMdToTxt } from '../../_shared/drive'
import { loadS3SettingsRecord, backfillAllEntries, isBackfillRunActive } from '../../_shared/s3Settings'

// One-time migration endpoint: renames legacy `.md` diary files to `.txt`.
// Idempotent and safe to call repeatedly; returns the number of files renamed.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let migratedDates: string[]
  try {
    migratedDates = await migrateMdToTxt(accessToken, sessionId, session, context.env)
  } catch (e) {
    console.error('migrate.ts: Failed to migrate entries', e)
    return jsonResponse({ error: 'Internal error' }, 500)
  }

  // The rename bumps each file's Drive version (see migrateMdToTxt), which strands
  // any prior S3 mirror of these dates on a now-stale stamped version — the badge
  // would report "pending" forever with nothing left to make it progress. Re-mirror
  // just these dates so their S3 status catches back up, mirroring backfill-retry.ts.
  // Kept in its own try/catch, separate from the rename above: the rename already
  // succeeded and must still be reported as such even if this best-effort follow-up
  // fails (e.g. a transient Drive read) — same "never throws" convention as
  // mirrorEntrySave/backfillAllEntries elsewhere in s3Settings.ts.
  let s3Resyncing = false
  if (migratedDates.length > 0) {
    try {
      const record = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
      // Skip if a chunked run (initial backfill, a resync, a failed-entries retry) is
      // already driving backfillProgress — this scoped run shares the same total/done/
      // remaining/finishedAt bookkeeping (see resync.ts's identical guard) and could
      // truncate a genuinely in-progress broader run. Not starting this one isn't a
      // regression: these dates' now-stale-versioned mirrors will report 'unconfirmed'
      // once opened, which useS3StaleEntryAutoResync already catches with an
      // account-wide resync, and the in-progress run's own listing may well cover them.
      const alreadyRunning = isBackfillRunActive(record?.status.backfillProgress)
      if (record?.config.enabled && !alreadyRunning) {
        context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, record, migratedDates, 'Migration re-sync', 20))
        s3Resyncing = true
      }
    } catch (e) {
      console.error('migrate.ts: Failed to start S3 re-mirror for migrated entries', e)
    }
  }

  // s3Resyncing tells the client to start its backfill-progress polling loop (see
  // useS3Backfill's startBackfill) — otherwise, once this chunked re-mirror exceeds
  // its 20-entry chunk, nothing would ever drive it to completion (backfill-continue
  // is only polled while that loop is active).
  return jsonResponse({ migrated: migratedDates.length, s3Resyncing })
}
