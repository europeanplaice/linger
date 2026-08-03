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
    DurationSeconds: '43200',
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
  // returns an unparseable Expiration — the fixed 12h (43200s) duration was requested, so
  // this is exact in practice, just defensive against an unexpected format ever making a
  // caller cache/persist a NaN expiry and treat these credentials as eternally valid.
  const parsedExpiration = Date.parse(raw.Expiration)
  const creds: AssumedCredentials = {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    sessionToken: raw.SessionToken,
    expiresAt: isNaN(parsedExpiration) ? Date.now() + 43200 * 1000 : parsedExpiration,
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

// S3 conditional-write headers (see putObjectIfNewer's comment for why they make
// the create/update atomic): If-Match pins an update to the exact etag a preceding
// HEAD just read, and If-None-Match: * lets at most one concurrent create win.
// Both behave differently under S3 bucket versioning: a create still succeeds (as
// a new version) and never 412s, and a delete becomes a delete marker — so a stale
// concurrent write can land last and become the bucket's "current" object. The
// version-ordering convergence for that case lives in the caller (convergeMirror in
// the S3 workflow Worker, driven by the Durable Object index's monotonic
// markSynced), so versioned buckets (as the self-host Terraform template ships)
// and unversioned buckets are both supported here.
export interface PutObjectOptions {
  ifMatch?: string
  ifNoneMatch?: string
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
  options?: PutObjectOptions,
): Promise<void> {
  const client = s3Client(creds, region)
  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (version) headers['x-amz-meta-linger-version'] = version
  if (options?.ifMatch) headers['If-Match'] = options.ifMatch
  if (options?.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch
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

interface HeadObjectResult {
  etag: string
  version: string | null
}

// Shared by headObjectVersion (below) and putObjectIfNewer's update path, which
// also needs the etag so its If-Match PUT can be atomic. Same miss/error
// semantics as headObjectVersion: only a 404 means "no object".
async function headObject(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<HeadObjectResult | null> {
  const client = s3Client(creds, region)
  const head = await client.fetch(objectUrl(bucket, region, key), { method: 'HEAD', signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS) })
  if (head.status === 404) return null
  if (!head.ok) {
    throw new S3Error(head.status, `S3 HeadObject failed: ${await head.text()}`)
  }
  return { etag: head.headers.get('etag') ?? '', version: head.headers.get('x-amz-meta-linger-version') }
}

// Reads the linger-stamped version off an object without fetching its body, or
// null if the object doesn't exist (or carries no version metadata). Only a 404
// means "no object" — any other error (403, network failure, …) is thrown rather
// than treated as a miss, so a caller can't mistake "can't tell" for "absent"
// and clobber an object it actually can't read.
export async function headObjectVersion(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<string | null> {
  return (await headObject(creds, bucket, region, key))?.version ?? null
}

// Guards against out-of-order mirror writes (e.g. two rapid saves of the same date from
// autosave + Ctrl+S, or two open tabs) leaving a stale version as the bucket's "current"
// object. Compares against the version already stored in the object's metadata rather
// than relying on request arrival order, which is not guaranteed under concurrent waitUntil
// calls.
//
// S3 conditional writes (If-None-Match / If-Match) replace the old pre-write HEAD + PUT +
// post-write HEAD sequence. That sequence needed the trailing HEAD because S3 has no
// compare-and-swap: two concurrent callers could both pass the pre-write HEAD and whichever
// PUT physically landed second would become "current" — even if it carried an older version.
// A conditional PUT closes the same window atomically, so no post-write confirmation is
// needed:
//
//   - expectExisting=false (a first mirror of a key, per the caller's DO index): an
//     If-None-Match: * PUT means at most one concurrent create can win; the loser gets a
//     412 and re-reads instead of blindly clobbering.
//   - expectExisting=true (an update): HEAD once, then an If-Match <etag> PUT that only
//     lands on the exact object state just validated — a newer write landing in between
//     surfaces as a 412 and the loop re-reads.
//
// Both paths also degrade to the other's preconditions (a 412 on a create downgrades to the
// update path; a 404 on an update's HEAD downgrades to the create path), so a wrong hint
// costs at most one request, never correctness. One caveat: under bucket versioning a
// create never 412s, so the downgrade can't fire — the caller's version-ordering
// convergence (see the S3 workflow Worker's convergeMirror) closes that gap using the
// Durable Object index. The legacy HEAD/PUT/HEAD sequence survives
// only as a fallback for endpoints that reject conditional writes (S3 on Outposts). Bounded
// and best-effort like every other write path in this file — a loss after all attempts
// self-heals on the next mirror/resync of this date.
const PUT_IF_NEWER_MAX_ATTEMPTS = 3

export interface PutObjectIfNewerOptions {
  // True when the caller believes the key already exists (an update to an object it
  // previously mirrored); false when it knows the key can't exist yet (a first mirror
  // of a date that has never been synced). Defaults to true: both a first mirror and an
  // update resolve in two requests that way (update: HEAD + If-Match PUT; first mirror:
  // HEAD 404 then If-None-Match PUT), while false collapses the first-mirror happy path
  // to a single If-None-Match PUT. The hint only changes the request count, never the
  // outcome — a 412/404 flips the path the other way.
  expectExisting?: boolean
}

// The pre-conditional-write HEAD/PUT/HEAD path, kept for endpoints that reject
// If-None-Match/If-Match. Same version-ordering guard as putObjectIfNewer, including
// the trailing HEAD that confirms our version (or a newer one) actually won the race.
async function putObjectIfNewerLegacy(
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
  throw new S3Error(409, `S3 PutObjectIfNewer: write did not land as version ${version} after ${PUT_IF_NEWER_MAX_ATTEMPTS} attempts`)
}

function isConditionalWriteUnsupported(error: unknown): boolean {
  // 501 (NotImplemented) is what S3 on Outposts-style endpoints return for a
  // conditional-write header; 400 is some endpoints' generic "bad header value" —
  // both mean "this feature isn't supported here, use the legacy sequence".
  return error instanceof S3Error && (error.status === 501 || error.status === 400)
}

export async function putObjectIfNewer(
  creds: AssumedCredentials,
  bucket: string,
  region: string,
  key: string,
  body: string,
  version?: string,
  contentType?: string,
  options?: PutObjectIfNewerOptions,
): Promise<void> {
  let expectExisting = options?.expectExisting ?? true
  for (let attempt = 0; attempt < PUT_IF_NEWER_MAX_ATTEMPTS; attempt++) {
    if (!version) {
      // No version, no ordering to guard — a plain PUT is enough.
      await putObject(creds, bucket, region, key, body, contentType)
      return
    }
    if (expectExisting) {
      // Update path: read the current state once, then reassert our version with
      // If-Match so a concurrent write can't slip in between the read and the write.
      const head = await headObject(creds, bucket, region, key)
      if (head) {
        if (head.version && isAtLeast(head.version, version)) return
        if (!head.etag) {
          // The endpoint omitted ETag on HEAD — an If-Match PUT would carry no
          // precondition (putObject only sets the header for a non-empty value),
          // silently degrading this update to a non-atomic PUT. Use the legacy
          // sequence, which re-reads and verifies the version after the write.
          return putObjectIfNewerLegacy(creds, bucket, region, key, body, version, contentType)
        }
        try {
          await putObject(creds, bucket, region, key, body, contentType, version, { ifMatch: head.etag })
          return
        } catch (error) {
          // 412: another writer moved the object after our HEAD — re-read and retry.
          if (error instanceof S3Error && error.status === 412) continue
          // 404: the object was deleted between our HEAD and PUT — re-create it.
          if (error instanceof S3Error && error.status === 404) { expectExisting = false; continue }
          if (isConditionalWriteUnsupported(error)) {
            return putObjectIfNewerLegacy(creds, bucket, region, key, body, version, contentType)
          }
          throw error
        }
      }
      // Object doesn't exist yet — fall through to the create path.
      expectExisting = false
      continue
    }
    // Create path: If-None-Match: * makes the create atomic — only one concurrent
    // caller can win, the loser gets a 412 and re-reads.
    try {
      await putObject(creds, bucket, region, key, body, contentType, version, { ifNoneMatch: '*' })
      return
    } catch (error) {
      // 412: a concurrent writer created the object between our check and now — switch
      // to the update path and re-read its version rather than clobbering blindly.
      if (error instanceof S3Error && error.status === 412) { expectExisting = true; continue }
      if (isConditionalWriteUnsupported(error)) {
        return putObjectIfNewerLegacy(creds, bucket, region, key, body, version, contentType)
      }
      throw error
    }
  }
  // Every attempt failed its conditional write (a persistently-losing race against
  // another concurrent writer) — callers must not treat this as success: markSynced on
  // a version the bucket doesn't actually hold would make the DO index permanently claim
  // "synced" for content that was never written, and nothing would ever revisit it since
  // entryStatusForAuth short-circuits on a synced record.
  throw new S3Error(409, `S3 PutObjectIfNewer: write did not land as version ${version} after ${PUT_IF_NEWER_MAX_ATTEMPTS} attempts`)
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

// Reads an object's body as text (used by the restore-from-backup path). Returns
// null when the object doesn't exist; any other error (403, network failure, …) is
// thrown rather than treated as a miss, so a caller can't mistake "can't tell" for
// "absent".
export async function getObjectContent(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<string | null> {
  const client = s3Client(creds, region)
  const resp = await client.fetch(objectUrl(bucket, region, key), { method: 'GET', signal: AbortSignal.timeout(S3_FETCH_TIMEOUT_MS) })
  if (resp.status === 404) return null
  if (!resp.ok) {
    throw new S3Error(resp.status, `S3 GetObject failed: ${await resp.text()}`)
  }
  return await resp.text()
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
