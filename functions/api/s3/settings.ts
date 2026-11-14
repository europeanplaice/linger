import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { getS3Settings, isValidS3Settings } from '../../_shared/s3Settings'
import { forwardS3Backup } from '../../_shared/s3BackupRequest'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const settings = await getS3Settings(accessToken, sessionId, session, context.env)
    return jsonResponse(settings)
  } catch (e) {
    console.error('s3/settings.ts: GET failed')
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}

export const onRequestPut: PagesFunction<Env, string, Data> = async context => {
  if (!context.data.session) return jsonResponse({ error: 'Unauthorized' }, 401)
  let body: unknown
  try { body = await context.request.json() }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  if (!isValidS3Settings(body)) return jsonResponse({ error: 'Invalid S3 settings (check Role ARN / bucket / region format)' }, 400)
  const { enabled, roleArn, bucket, region } = body
  return forwardS3Backup(context, { kind: 'settings', config: { enabled, roleArn, bucket, region } })
}
