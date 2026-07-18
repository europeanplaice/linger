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

export function isAtLeast(existing: string, incoming: string): boolean {
  try {
    return BigInt(existing) >= BigInt(incoming)
  } catch {
    return false // unexpected (non-numeric) version format — don't block the write
  }
}

// Reads the linger-stamped version off an object without fetching its body, or
// null if the object doesn't exist (or carries no version metadata).
export async function headObjectVersion(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<string | null> {
  const client = s3Client(creds, region)
  const head = await client.fetch(objectUrl(bucket, region, key), { method: 'HEAD' })
  if (!head.ok) return null
  return head.headers.get('x-amz-meta-linger-version')
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
    const existing = await headObjectVersion(creds, bucket, region, key)
    if (existing && isAtLeast(existing, version)) return
  }
  await putObject(creds, bucket, region, key, body, contentType, version)
}

function unescapeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    switch (entity) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: return _m
    }
  })
}

// Caps ListObjectsV2 pagination — diary buckets hold at most one object per saved
// date, so real accounts never come close to this; it just bounds worst-case latency
// against a bucket stuffed with unrelated objects sharing the "diary-" prefix.
const MAX_LIST_PAGES = 10

// Lists object keys under `prefix`. S3's XML response is parsed with regexes (like
// describeError does for error bodies below) rather than a full XML parser, which
// the Workers runtime doesn't provide and this simple flat structure doesn't need.
export async function listObjectKeys(creds: AssumedCredentials, bucket: string, region: string, prefix: string): Promise<string[]> {
  const client = s3Client(creds, region)
  const keys: string[] = []
  let continuationToken: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' })
    if (continuationToken) params.set('continuation-token', continuationToken)
    const resp = await client.fetch(`https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`, { method: 'GET' })
    if (!resp.ok) {
      throw new S3Error(resp.status, `S3 ListObjectsV2 failed: ${await resp.text()}`)
    }
    const xml = await resp.text()
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      keys.push(unescapeXmlEntities(match[1]))
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)
    if (!tokenMatch) break
    continuationToken = unescapeXmlEntities(tokenMatch[1])
  }
  return keys
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
