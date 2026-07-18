import type { Env, Data } from '../../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../../_shared/session'
import { assumeRoleWithWebIdentity, headObjectVersion, isAtLeast } from '../../../_shared/s3'
import { getS3Settings, entryKey } from '../../../_shared/s3Settings'

// Polled by the editor right after a Drive save to learn whether the S3 mirror
// (written asynchronously via context.waitUntil, see drive/entry/[date].ts) has
// caught up to that specific save yet. Never persists anything itself — it just
// reads the version already stamped on the mirrored object (see s3.ts) and the
// account-wide lastSyncError/lastSyncErrorAt already recorded by the mirror.
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

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
    const existingVersion = await headObjectVersion(creds, settings.bucket, settings.region, entryKey(date))
    if (existingVersion && isAtLeast(existingVersion, version)) return jsonResponse({ status: 'synced' })

    // Only attribute a failure to this save if it was recorded after the save
    // attempt started — otherwise a stale, unrelated failure (e.g. from a
    // previous outage) would wrongly mark a brand-new, still-in-flight save
    // as failed.
    if (settings.lastSyncErrorAt && (!since || settings.lastSyncErrorAt > since)) {
      return jsonResponse({ status: 'failed', error: settings.lastSyncError })
    }
    return jsonResponse({ status: 'pending' })
  } catch (e) {
    // A transient failure of this status check itself (network blip, STS hiccup)
    // is not the same as a recorded mirror failure — don't surface it as one.
    console.error('s3/entry-status.ts: check failed', e)
    return jsonResponse({ status: 'pending' })
  }
}
