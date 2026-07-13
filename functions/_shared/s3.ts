import { AwsClient } from 'aws4fetch'

export class S3Error extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'S3Error'
  }
}

interface AssumedCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

// sts:AssumeRoleWithWebIdentity is unauthenticated (that's the point of web
// identity federation) — no request signing needed for this call itself, only
// for the S3 requests made afterwards with the credentials it returns.
export async function assumeRoleWithWebIdentity(idToken: string, roleArn: string, region: string): Promise<AssumedCredentials> {
  const params = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: 'linger',
    WebIdentityToken: idToken,
    DurationSeconds: '3600',
  })

  const resp = await fetch(`https://sts.${region}.amazonaws.com/?${params.toString()}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new S3Error(resp.status, `STS AssumeRoleWithWebIdentity failed: ${body}`)
  }

  const data = await resp.json() as {
    AssumeRoleWithWebIdentityResponse: {
      AssumeRoleWithWebIdentityResult: {
        Credentials: {
          AccessKeyId: string
          SecretAccessKey: string
          SessionToken: string
        }
      }
    }
  }
  const creds = data.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  }
}

function s3Client(creds: AssumedCredentials, region: string): AwsClient {
  return new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region,
    service: 's3',
  })
}

function objectUrl(bucket: string, region: string, key: string): string {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`
}

// `version` (Drive's monotonically increasing per-file version string) is stamped as
// object metadata so a later write can tell whether it would clobber a newer one.
export async function putObject(
  creds: AssumedCredentials,
  bucket: string,
  region: string,
  key: string,
  body: string,
  contentType = 'text/plain; charset=UTF-8',
  version?: string,
): Promise<void> {
  const client = s3Client(creds, region)
  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (version) headers['x-amz-meta-linger-version'] = version
  const resp = await client.fetch(objectUrl(bucket, region, key), {
    method: 'PUT',
    headers,
    body,
  })
  if (!resp.ok) {
    throw new S3Error(resp.status, `S3 PutObject failed: ${await resp.text()}`)
  }
}

function isAtLeast(existing: string, incoming: string): boolean {
  try {
    return BigInt(existing) >= BigInt(incoming)
  } catch {
    return false // unexpected (non-numeric) version format — don't block the write
  }
}

// Guards against out-of-order mirror writes (e.g. two rapid saves of the same date from
// autosave + Ctrl+S, or two open tabs) leaving a stale version as the bucket's "current"
// object. Compares against the version already stored in the object's metadata rather
// than relying on request arrival order, which is not guaranteed under concurrent waitUntil
// calls.
export async function putObjectIfNewer(
  creds: AssumedCredentials,
  bucket: string,
  region: string,
  key: string,
  body: string,
  version?: string,
  contentType?: string,
): Promise<void> {
  if (version) {
    const client = s3Client(creds, region)
    const head = await client.fetch(objectUrl(bucket, region, key), { method: 'HEAD' })
    if (head.ok) {
      const existing = head.headers.get('x-amz-meta-linger-version')
      if (existing && isAtLeast(existing, version)) return
    }
  }
  await putObject(creds, bucket, region, key, body, contentType, version)
}

export async function deleteObject(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<void> {
  const client = s3Client(creds, region)
  const resp = await client.fetch(objectUrl(bucket, region, key), { method: 'DELETE' })
  if (!resp.ok && resp.status !== 404) {
    throw new S3Error(resp.status, `S3 DeleteObject failed: ${await resp.text()}`)
  }
}

// Extracts a short human-readable message from an S3/STS error (XML or JSON error body),
// or from any other Error, truncated so it's safe to surface to the user and to store.
export function describeError(e: unknown): string {
  let detail: string
  if (e instanceof S3Error) {
    const match = e.message.match(/<Message>([^<]+)<\/Message>/) ?? e.message.match(/"message"\s*:\s*"([^"]+)"/i)
    detail = match?.[1] ?? e.message
  } else if (e instanceof Error) {
    detail = e.message
  } else {
    detail = 'Unknown error'
  }
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
}
