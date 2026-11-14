import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { migrateMdToTxt } from '../../_shared/drive'
import { forwardS3Backup } from '../../_shared/s3BackupRequest'

// One-time migration endpoint: renames legacy `.md` diary files to `.txt`.
// Idempotent and safe to call repeatedly; returns the number of files renamed.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let migratedDates: string[]
  try {
    migratedDates = await migrateMdToTxt(accessToken, sessionId, session, context.env)
  } catch (e) {
    console.error('migrate.ts: Failed to migrate entries')
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
      // Skip if a chunked run (initial backfill, a resync, a failed-entries retry) is
      // already driving backfillProgress — this scoped run shares the same total/done/
      // remaining/finishedAt bookkeeping. The account coordinator checks and
      // reserves the run together, so another tab cannot pass the same guard.
      const response = await forwardS3Backup(context, { kind: 'start', dates: migratedDates })
      s3Resyncing = response.ok
    } catch (e) {
      console.error('migrate.ts: Failed to start S3 re-mirror for migrated entries')
    }
  }

  // s3Resyncing tells the client to start its backfill-progress polling loop (see
  // useS3Backfill's startBackfill) — otherwise, once this chunked re-mirror exceeds
  // its 20-entry chunk, nothing would ever drive it to completion (backfill-continue
  // is only polled while that loop is active).
  return jsonResponse({ migrated: migratedDates.length, s3Resyncing })
}
