import type { Env, Data } from '../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../_shared/session'
import { assumeRoleWithWebIdentity, putObject, deleteObject, S3Error, describeError } from '../../_shared/s3'
import { S3_ROLE_ARN_RE, S3_BUCKET_RE, S3_REGION_RE } from '../../_shared/s3Settings'

// Writes and immediately deletes a small marker object — proves the role trust
// policy and bucket permissions actually work end to end, not just that the
// fields are well-formed. Same key every time so repeated tests don't litter
// the bucket if a delete ever fails.
const TEST_KEY = '_linger_connection_test.txt'

export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { sessionId, session } = context.data
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
    await putObject(creds, bucket, region, TEST_KEY, `linger connection test — ${new Date().toISOString()}`)
    await deleteObject(creds, bucket, region, TEST_KEY)
    return jsonResponse({ ok: true })
  } catch (e) {
    if (e instanceof S3Error) {
      console.error('s3/test.ts: connection test failed', e)
      return jsonResponse({ ok: false, error: describeError(e) })
    }
    console.error('s3/test.ts: unexpected failure', e)
    return jsonResponse({ ok: false, error: 'Unexpected error' })
  }
}
