import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { loadS3SettingsRecord, backfillAllEntries, finishBackfill } from '../../_shared/s3Settings'

const BACKFILL_CHUNK_SIZE = 20

// Continues a chunked backfill that was previously started but not yet finished.
// The client calls this endpoint repeatedly (driven by its polling loop) until
// backfillProgress.finishedAt is set. `backfillProgress.remaining` (the exact set of
// dates this run still owes — see backfillAllEntries) is the single source of truth
// for what's left; this handler never re-derives it from a fresh Drive listing or a
// positional cursor, so it stays correct across chunks regardless of entries being
// added/removed mid-run, and preserves a scoped run's target set (e.g. a migration
// re-sync) instead of drifting onto unrelated entries.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const record = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
    if (!record) return jsonResponse({ error: 'S3 backup is not configured' }, 400)
    if (!record.config.enabled) return jsonResponse({ error: 'S3 backup is not enabled' }, 400)

    const progress = record.status.backfillProgress

    // Nothing to do: backfill already finished.
    if (progress?.finishedAt) {
      return jsonResponse({ ok: true, done: true })
    }

    // No progress record yet — the initial/resync chunk is still in-flight or
    // already finished and cleared the record. Don't start a brand-new backfill
    // here; the trigger endpoint (settings.ts / resync.ts / backfill-retry.ts)
    // is responsible for kicking off the first chunk. Return done: false so the
    // client keeps polling and re-checks once progress appears.
    if (!progress) {
      return jsonResponse({ ok: true, done: false })
    }

    // A record from before `remaining` was tracked (in-flight across a deploy) can't be
    // safely resumed by position — finalize with whatever's already recorded and let the
    // user's next Resync fully reconcile any gap, rather than risk silently dropping dates.
    if (!progress.remaining || progress.remaining.length === 0) {
      await finishBackfill(accessToken, record, progress.total, progress.failed, 'Backfill')
      return jsonResponse({ ok: true, done: true })
    }

    // Fire-and-forget inside waitUntil so the response returns immediately. backfillAllEntries
    // does its own chunking (BACKFILL_CHUNK_SIZE) over the full remaining scope, and persists
    // whatever's left afterward — the client's polling loop calls this endpoint again for it.
    context.waitUntil(backfillAllEntries(
      accessToken, sessionId, session, context.env,
      record, progress.remaining, 'Backfill', BACKFILL_CHUNK_SIZE,
    ))

    return jsonResponse({ ok: true, remaining: progress.remaining.length })
  } catch (e) {
    console.error('s3/backfill-continue.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
