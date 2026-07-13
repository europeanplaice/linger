import type { Env, SessionData } from './session'
import { getValidIdToken } from './session'
import { ensureFolder, findJsonFile, readJsonFile } from './drive'
import { assumeRoleWithWebIdentity, putObject, deleteObject } from './s3'

export const S3_SETTINGS_FILE_NAME = 's3_settings.json'

export const S3_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/
export const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
export const S3_REGION_RE = /^[a-z]{2}-[a-z]+-\d$/

export interface S3Settings {
  enabled: boolean
  roleArn: string
  bucket: string
  region: string
}

export function isValidS3Settings(body: unknown): body is S3Settings {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.enabled === 'boolean'
    && typeof b.roleArn === 'string' && S3_ROLE_ARN_RE.test(b.roleArn)
    && typeof b.bucket === 'string' && S3_BUCKET_RE.test(b.bucket)
    && typeof b.region === 'string' && S3_REGION_RE.test(b.region)
}

export async function getS3Settings(token: string, sessionId: string, session: SessionData, env: Env): Promise<S3Settings | null> {
  const folderId = await ensureFolder(token, sessionId, session, env)
  const fileId = await findJsonFile(token, folderId, S3_SETTINGS_FILE_NAME)
  if (!fileId) return null

  let data: unknown
  try {
    data = await readJsonFile<unknown>(token, fileId)
  } catch (e) {
    if (e instanceof SyntaxError) return null
    throw e
  }
  return isValidS3Settings(data) ? data : null
}

function entryKey(date: string): string {
  return `diary-${date}.txt`
}

// Best-effort mirror to the user's own S3 bucket — never throws. A failure here
// must not turn a successful Drive save (the source of truth) into an error
// response, so every failure mode is caught and logged instead of propagated.
// Callers should invoke this via context.waitUntil so it doesn't block the response.
export async function mirrorEntrySave(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  date: string,
  content: string,
): Promise<void> {
  try {
    const settings = await getS3Settings(accessToken, sessionId, session, env)
    if (!settings || !settings.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) return

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
    await putObject(creds, settings.bucket, settings.region, entryKey(date), content)
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntrySave failed', e)
  }
}

export async function mirrorEntryDelete(
  accessToken: string,
  sessionId: string,
  session: SessionData,
  env: Env,
  date: string,
): Promise<void> {
  try {
    const settings = await getS3Settings(accessToken, sessionId, session, env)
    if (!settings || !settings.enabled) return

    const idToken = await getValidIdToken(sessionId, session, env)
    if (!idToken) return

    const creds = await assumeRoleWithWebIdentity(idToken, settings.roleArn, settings.region)
    await deleteObject(creds, settings.bucket, settings.region, entryKey(date))
  } catch (e) {
    console.error('s3Settings.ts: mirrorEntryDelete failed', e)
  }
}
