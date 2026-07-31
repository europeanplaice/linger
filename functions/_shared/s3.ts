import { AwsClient } from 'aws4fetch'

export class S3Error extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'S3Error'
  }
}

// `expiresAt` (ms since epoch, from STS's own Expiration) is exposed to callers so a
// longer-lived cache than this module's own in-isolate one (see s3Settings.ts's
// getAssumedCredentials, which persists this in the user's KV session — isolates for a
// low-traffic app go cold between requests far more often than this in-memory Map ever
// gets to help) can also tell a still-good credential from an expired one.
export interface AssumedCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiresAt: number
}

// Opportunistic cross-request cache: Cloudflare Workers isolates commonly persist
// module-scope state across requests while warm (not guaranteed — purely a best-effort
// optimization, never relied on for correctness). Avoids re-assuming the role on every
// save/delete mirror and every entry-status poll (up to 4 per save) within the same
// warm isolate. Keyed by caller-supplied `cacheKey` — callers must key this uniquely
// per user (e.g. `${google_sub}:${roleArn}:${region}`) so credentials for one account
// can never be handed out for another; omit the key to opt out of caching entirely.
const credentialsCache = new Map<string, AssumedCredentials>()
// Treat cached credentials as expired this far ahead of their real STS expiry, so a
// cache hit never hands out credentials that could die mid-operation. Generous enough
// that backfillAllEntries — which assumes a role once and then runs a multi-minute
// chunked operation on those same credentials — never starts a chunk with too little
// runway left on them.
export const CREDENTIALS_EXPIRY_MARGIN_MS = 15 * 60 * 1000

// Bounds every outbound STS/S3 request (headers *and* body — an AbortSignal cancels
// the whole exchange, unlike racing a wrapper promise around just the fetch() call)
// so a stalled connection can't block a Workers invocation indefinitely (e.g. a
// backfill chunk stuck reading one entry's response, silently killed by the
// platform's CPU/wall-clock limit with no error ever recorded) — instead it fails
// after this long, which the caller can catch and skip past like any other error.
// Every fetch()/client.fetch() call below passes this as `signal`; a fresh one is
// created per call so each of putObjectIfNewer's retry attempts gets its own budget.
const S3_FETCH_TIMEOUT_MS = 20_000

// sts:AssumeRoleWithWebIdentity is unauthenticated (that's the point of web
// identity federation) — no request signing needed for this call itself, only
// for the S3 requests made afterwards with the credentials it returns.
export async function assumeRoleWithWebIdentity(idToken: string, roleArn: string, region: string, cacheKey?: string): Promise<AssumedCredentials> {
  if (cacheKey) {
    const cached = credentialsCache.get(cacheKey)
    if (cached && cached.expiresAt - CREDENTIALS_EXPIRY_MARGIN_MS > Date.now()) return cached
  }

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
    signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS),
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
          Expiration: string
        }
      }
    }
  }
  const raw = data.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials
  // Falls back to a conservative estimate (DurationSeconds requested above) if STS ever
  // returns an unparseable Expiration — the fixed 3600s duration was requested, so this
  // is exact in practice, just defensive against an unexpected format ever making a
  // caller cache/persist a NaN expiry and treat these credentials as eternally valid.
  const parsedExpiration = Date.parse(raw.Expiration)
  const creds: AssumedCredentials = {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    sessionToken: raw.SessionToken,
    expiresAt: isNaN(parsedExpiration) ? Date.now() + 3600 * 1000 : parsedExpiration,
  }

  if (cacheKey) credentialsCache.set(cacheKey, creds)

  return creds
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
    signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS),
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
  const head = await client.fetch(objectUrl(bucket, region, key), { method: 'HEAD', signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS) })
  if (!head.ok) return null
  return head.headers.get('x-amz-meta-linger-version')
}

// Guards against out-of-order mirror writes (e.g. two rapid saves of the same date from
// autosave + Ctrl+S, or two open tabs) leaving a stale version as the bucket's "current"
// object. Compares against the version already stored in the object's metadata rather
// than relying on request arrival order, which is not guaranteed under concurrent waitUntil
// calls.
//
// The pre-write HEAD check alone only narrows that window, it doesn't close it: S3 has no
// compare-and-swap, so two concurrent callers can both pass the check before either PUTs,
// and whichever PUT physically lands second becomes the object's "current" version — even
// if it's the older one. So after our own PUT, we re-HEAD to confirm our version (or a
// still-newer one from another writer) actually won; if a stale write landed after ours, we
// retry to reassert. Bounded and best-effort like every other write path in this file — a
// loss after all attempts self-heals on the next mirror/resync of this date.
const PUT_IF_NEWER_MAX_ATTEMPTS = 3

export async function putObjectIfNewer(
  creds: AssumedCredentials,
  bucket: string,
  region: string,
  key: string,
  body: string,
  version?: string,
  contentType?: string,
): Promise<void> {
  for (let attempt = 0; attempt < PUT_IF_NEWER_MAX_ATTEMPTS; attempt++) {
    if (version) {
      const existing = await headObjectVersion(creds, bucket, region, key)
      if (existing && isAtLeast(existing, version)) return
    }
    await putObject(creds, bucket, region, key, body, contentType, version)
    if (!version) return
    const landed = await headObjectVersion(creds, bucket, region, key)
    if (landed && isAtLeast(landed, version)) return
  }
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
    const resp = await client.fetch(`https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`, { method: 'GET', signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS) })
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
  const resp = await client.fetch(objectUrl(bucket, region, key), { method: 'DELETE', signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS) })
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
