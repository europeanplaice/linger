import type { Env, Data } from '../../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../../_shared/session'
import { assumeRoleWithWebIdentity, headObjectVersion, isAtLeast } from '../../../_shared/s3'
import { getS3Settings, entryKey } from '../../../_shared/s3Settings'

// Polled by the editor right after a Drive save to learn whether the S3 mirror
// (written asynchronously via context.waitUntil, see drive/entry/[date].ts) has
// caught up to that specific save yet. Never persists anything itself — it just
// reads the version already stamped on the mirrored object (see s3.ts), the
// account-wide lastSyncError/lastSyncErrorAt already recorded by the mirror, and
// the per-date backfillProgress.failed list recorded by backfillAllEntries.
export const onRequestGet: PagesFunction<Env, 'date', Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  const date = context.params.date as string

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  const url = new URL(context.request.url)
  const version = url.searchParams.get('version')
  const since = url.searchParams.get('since')
  if (!version) return jsonResponse({ error: 'version is required' }, 400)

  try {
    const settings = await getS3Settings(accessToken, sessionId, session, context.env)
    if (!settings || !settings.enabled) return jsonResponse({ status: 'disabled' })

    const idToken = await getValidIdToken(sessionId, session, context.env)
    if (!idToken) return jsonResponse({ status: 'pending' })

    try {
      const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
      const existingVersion = await headObjectVersion(creds, settings.bucket, settings.region, entryKey(date))
      if (existingVersion && isAtLeast(existingVersion, version)) return jsonResponse({ status: 'synced' })
    } catch (e) {
      console.error('s3/entry-status.ts: S3/STS operation failed', e)
    }

    // A finished backfill (or backfill retry) that explicitly failed on this exact date
    // is a stronger, date-specific signal than lastSyncErrorAt below — and unlike it,
    // isn't at risk of going stale/cleared by an unrelated successful save elsewhere
    // (recordMirrorSuccess clears lastSyncError on any successful mirror, but never
    // touches backfillProgress). Surface it regardless of `since`; nothing will re-sync
    // this date until the user retries the backfill from Settings.
    if (settings.backfillProgress?.finishedAt && settings.backfillProgress.failed.includes(date)) {
      return jsonResponse({ status: 'failed', error: settings.lastSyncError ?? 'Backfill failed for this entry — retry from Settings.' })
    }

    // Only attribute a failure to this save if it was recorded after the save
    // attempt started — otherwise a stale, unrelated failure (e.g. from a
    // previous outage) would wrongly mark a brand-new, still-in-flight save
    // as failed. However, if the error is persistent and unchanged, we avoid
    // writing to Drive, meaning the timestamp doesn't update. If a significant
    // amount of time has elapsed (e.g., 5 seconds) and we are still not synced,
    // we fallback to reporting the recorded error.
    const sinceTime = since ? Date.parse(since) : NaN
    const elapsedMs = !isNaN(sinceTime) ? Date.now() - sinceTime : 0
    if (settings.lastSyncErrorAt) {
      const isPersistentError = elapsedMs > 5000 && elapsedMs < 30000
      if (!since || settings.lastSyncErrorAt > since || isPersistentError) {
        return jsonResponse({ status: 'failed', error: settings.lastSyncError })
      }
    }
    return jsonResponse({ status: 'pending' })
  } catch (e) {
    // A transient failure of this status check itself (network blip, STS hiccup)
    // is not the same as a recorded mirror failure — don't surface it as one.
    console.error('s3/entry-status.ts: check failed', e)
    return jsonResponse({ status: 'pending' })
  }
}
