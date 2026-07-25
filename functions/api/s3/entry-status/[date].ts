import type { Env, Data } from '../../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../../_shared/session'
import { assumeRoleWithWebIdentity, headObjectVersion, isAtLeast, describeError } from '../../../_shared/s3'
import { getS3Settings, entryKey, credentialsCacheKey } from '../../../_shared/s3Settings'

// How long a fresh save's 'pending' is trusted to mean "the mirror is genuinely
// still in flight, ask again shortly" before it's treated as "nothing is actually
// working toward this and won't resolve on its own" (see the pending/unconfirmed
// split at the bottom of this handler). Comfortably longer than the editor's own
// bounded retry schedule (S3_POLL_DELAYS_MS in EntryEditor.tsx, ~16.5s total) so
// a genuinely slow-but-in-flight mirror isn't cut off mid-flight.
const PENDING_GRACE_MS = 20_000

// Polled by the editor right after a Drive save, and once when an entry is simply
// opened, to learn the S3 mirror status for a given Drive version. Never persists
// anything itself — it just reads the version already stamped on the mirrored
// object (see s3.ts), the account-wide lastSyncError/lastSyncErrorAt already
// recorded by the mirror, and the per-date backfillProgress recorded by
// backfillAllEntries.
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

    let stsError: unknown = null
    if (idToken) {
      try {
        const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region, credentialsCacheKey(session, settings))
        const existingVersion = await headObjectVersion(creds, settings.bucket, settings.region, entryKey(date))
        if (existingVersion && isAtLeast(existingVersion, version)) return jsonResponse({ status: 'synced' })
      } catch (e) {
        console.error('s3/entry-status.ts: S3/STS operation failed', e)
        stsError = e
      }
    } else {
      // No ID token means the S3 check itself can't even run — but that's not
      // necessarily fatal to *this* check: a prior mirror attempt hitting the
      // same problem would already have recorded it via recordMirrorFailure, and
      // the lastSyncErrorAt check below will surface it. If nothing has recorded
      // it yet, fall through to the stsError check further down instead of
      // returning a blind 'pending' that a missing token can never resolve on
      // its own (previously this returned early here, ahead of every other
      // check, silently swallowing an already-recorded failure too).
      stsError = new Error('No Google ID token in this session — sign out and sign in again')
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

    // If the STS/S3 call itself failed (e.g. InvalidIdentityToken, or a missing ID
    // token above) and no other error was already surfaced above, report it as
    // failed — it won't resolve without user intervention (re-login or IAM fix),
    // so returning pending would keep the UI stuck in "syncing" forever.
    if (stsError) {
      return jsonResponse({ status: 'failed', error: describeError(stsError) })
    }

    // A running backfill (or a chunk that just hasn't reached this date yet) is a
    // stronger, more specific "still working on it" signal than the generic
    // pending/unconfirmed split below — keep the client polling rather than let it
    // settle into 'unconfirmed' out from under a run that's still in progress.
    if (settings.backfillProgress && !settings.backfillProgress.finishedAt) {
      return jsonResponse({ status: 'backfilling' })
    }

    // Nothing above found a reason this date isn't synced yet. Right after a save
    // (`since` set), a genuinely in-flight mirror needs a short grace window to
    // land — report 'pending' so the editor's bounded retry can catch it landing.
    // Beyond that window, or when there was no save to wait on in the first place
    // (the entry was simply opened and nothing is actively mirroring it), nothing
    // is going to change this on its own — report 'unconfirmed' instead of an
    // eternal 'pending' so the client can stop polling blindly and offer a retry.
    if (since && elapsedMs < PENDING_GRACE_MS) return jsonResponse({ status: 'pending' })
    return jsonResponse({ status: 'unconfirmed' })
  } catch (e) {
    // A transient failure of this status check itself (network blip, STS hiccup)
    // is not the same as a recorded mirror failure — don't surface it as one.
    console.error('s3/entry-status.ts: check failed', e)
    return jsonResponse({ status: 'pending' })
  }
}
