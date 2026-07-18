import type { Env, Data } from '../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../_shared/session'
import { assumeRoleWithWebIdentity, listObjectKeys, S3Error, describeError } from '../../_shared/s3'
import { listEntries } from '../../_shared/drive'
import { S3_ROLE_ARN_RE, S3_BUCKET_RE, S3_REGION_RE, DIARY_FILENAME_RE } from '../../_shared/s3Settings'

// Run before the first-time backfill (see api/s3/settings.ts) so the UI can warn the
// user before diary-dated objects already sitting in the bucket get silently
// overwritten — backfillAllEntries has no way to tell "foreign file with a matching
// name" apart from "stale mirror copy from a previous enable" and will clobber both.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' })
  }

  const b = (body ?? {}) as Record<string, unknown>
  const roleArn = typeof b.roleArn === 'string' ? b.roleArn : ''
  const bucket = typeof b.bucket === 'string' ? b.bucket : ''
  const region = typeof b.region === 'string' ? b.region : ''

  if (!S3_ROLE_ARN_RE.test(roleArn)) return jsonResponse({ ok: false, error: 'Invalid Role ARN format' })
  if (!S3_BUCKET_RE.test(bucket)) return jsonResponse({ ok: false, error: 'Invalid bucket name format' })
  if (!S3_REGION_RE.test(region)) return jsonResponse({ ok: false, error: 'Invalid region format' })

  try {
    const idToken = await getValidIdToken(sessionId, session, context.env)
    if (!idToken) return jsonResponse({ ok: false, error: 'No Google ID token in this session — sign out and sign in again' })

    const creds = await assumeRoleWithWebIdentity(idToken, roleArn, region)
    const [existingKeys, entries] = await Promise.all([
      listObjectKeys(creds, bucket, region, 'diary-'),
      listEntries(accessToken, sessionId, session, context.env),
    ])
    const driveKeys = new Set(entries.map(e => e.name).filter(name => DIARY_FILENAME_RE.test(name)))
    const collisions = existingKeys.filter(key => driveKeys.has(key)).sort()
    return jsonResponse({ ok: true, collisions })
  } catch (e) {
    if (e instanceof S3Error) {
      console.error('s3/precheck.ts: precheck failed', e)
      return jsonResponse({ ok: false, error: describeError(e) })
    }
    console.error('s3/precheck.ts: unexpected failure', e)
    return jsonResponse({ ok: false, error: 'Unexpected error' })
  }
}
