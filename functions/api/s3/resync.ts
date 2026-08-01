import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { loadS3SettingsRecord, backfillAllEntries, isBackfillRunActive } from '../../_shared/s3Settings'

// Re-mirrors every existing entry against S3 (backfillAllEntries with no `onlyDates`
// filter) — putObjectIfNewer skips anything already at least as new as Drive, so this is
// safe to run any time, not just once. Triggered by the "Resync all" button in Settings.
// Unlike backfill-retry, this also catches individual per-save mirror misses (e.g. a
// dropped Google id_token on refresh) that never made it into backfillProgress.failed,
// since those only ever get recorded — and thus become retryable — by a backfill run.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    if (context.env.S3_WORKFLOW_SERVICE && session.google_sub) {
      try {
        const result = await context.env.S3_WORKFLOW_SERVICE.startBackfill({
          sessionId,
          accountKey: session.google_sub,
          requestId: context.request.headers.get('X-Request-ID') ?? crypto.randomUUID(),
        })
        return jsonResponse({ ok: true, jobId: result.job.jobId }, 202)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.includes('already running')) return jsonResponse({ error: message }, 409)
        console.error('s3/resync.ts: Workflow start failed', error)
        return jsonResponse({ error: 'Unable to start backfill' }, 502)
      }
    }
    const record = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
    if (!record) return jsonResponse({ error: 'S3 backup is not configured' }, 400)
    if (!record.config.enabled) return jsonResponse({ error: 'S3 backup is not enabled' }, 400)

    // See backfill-retry.ts's identical guard: a second freshStart run sharing the same
    // total/done/remaining/finishedAt bookkeeping as an already-running backfill (the
    // initial backfill, another resync from a second tab, or a retry) can race it —
    // whichever finishes its own scope first calls finishBackfill and truncates the
    // other. Client-side gating (SettingsModal disables the button while busy) can't
    // close the multi-tab/stale-UI version of this, so it's enforced here too.
    // isBackfillRunActive treats a run with no recent progress write as abandoned
    // rather than active, so an orphaned run can't permanently 409 every future resync.
    if (isBackfillRunActive(record.status.backfillProgress)) {
      return jsonResponse({ error: 'A backfill is already running' }, 409)
    }

    context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, record, undefined, 'Resync', 20))
    return jsonResponse({ ok: true })
  } catch (e) {
    console.error('s3/resync.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
