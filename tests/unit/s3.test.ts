import { describe, expect, it, vi, afterEach } from 'vitest'
import { assumeRoleWithWebIdentity, putObject, putObjectIfNewer, deleteObject, listObjectKeys, S3Error, describeError } from '../../functions/_shared/s3'

const creds = { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assumeRoleWithWebIdentity', () => {
  it('parses the AssumeRoleWithWebIdentity response into flat credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      AssumeRoleWithWebIdentityResponse: {
        AssumeRoleWithWebIdentityResult: {
          Credentials: { AccessKeyId: 'ak', SecretAccessKey: 'sk', SessionToken: 'st' },
        },
      },
    }), { status: 200 })))

    const result = await assumeRoleWithWebIdentity('idtok', 'arn:aws:iam::123456789012:role/linger-s3', 'us-east-1')

    expect(result).toEqual(creds)
  })

  it('throws S3Error with the response body on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('AccessDenied', { status: 403 })))

    await expect(assumeRoleWithWebIdentity('idtok', 'arn:aws:iam::123456789012:role/linger-s3', 'us-east-1'))
      .rejects.toMatchObject({ status: 403 })
  })
})

describe('putObject', () => {
  it('PUTs to the virtual-hosted-style URL with the given content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await putObject(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello')

    const request: Request = fetchMock.mock.calls[0][0]
    expect(request.url).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/diary-2026-01-01.txt')
    expect(request.method).toBe('PUT')
  })

  it('stamps the version as x-amz-meta-linger-version when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await putObject(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', 'text/plain', '7')

    const request: Request = fetchMock.mock.calls[0][0]
    expect(request.headers.get('x-amz-meta-linger-version')).toBe('7')
  })

  it('throws S3Error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })))

    await expect(putObject(creds, 'my-bucket', 'us-east-1', 'k', 'body')).rejects.toBeInstanceOf(S3Error)
  })
})

describe('putObjectIfNewer', () => {
  it('writes when no version is given (no ordering to guard)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await putObjectIfNewer(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][0] as Request).method).toBe('PUT')
  })

  it('writes when the existing object is older than the incoming version', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'x-amz-meta-linger-version': '5' } })) // HEAD
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // PUT
    vi.stubGlobal('fetch', fetchMock)

    await putObjectIfNewer(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '7')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0][0] as Request).method).toBe('HEAD')
    expect((fetchMock.mock.calls[1][0] as Request).method).toBe('PUT')
  })

  it('skips the write when the existing object is already at least as new', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'x-amz-meta-linger-version': '9' } })) // HEAD
    vi.stubGlobal('fetch', fetchMock)

    await putObjectIfNewer(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '7')

    expect(fetchMock).toHaveBeenCalledTimes(1) // HEAD only, no PUT
  })

  it('writes when the HEAD comes back without an object (first mirror of this key)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 })) // HEAD: not found
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // PUT
    vi.stubGlobal('fetch', fetchMock)

    await putObjectIfNewer(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('writes when the existing version metadata is not a parseable number', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'x-amz-meta-linger-version': 'not-a-number' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await putObjectIfNewer(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('listObjectKeys', () => {
  function listXml(keys: string[], opts: { truncated?: boolean; nextToken?: string } = {}) {
    const contents = keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')
    return `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>${opts.nextToken ? `<NextContinuationToken>${opts.nextToken}</NextContinuationToken>` : ''}</ListBucketResult>`
  }

  it('returns keys from a single, non-truncated page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(listXml(['diary-2026-01-01.txt', 'diary-2026-01-02.txt']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const keys = await listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')

    expect(keys).toEqual(['diary-2026-01-01.txt', 'diary-2026-01-02.txt'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request: Request = fetchMock.mock.calls[0][0]
    expect(request.method).toBe('GET')
    expect(request.url).toContain('https://my-bucket.s3.us-east-1.amazonaws.com/?')
    expect(request.url).toContain('list-type=2')
    expect(request.url).toContain('prefix=diary-')
  })

  it('follows continuation tokens until IsTruncated is false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(listXml(['diary-2026-01-01.txt'], { truncated: true, nextToken: 'tok-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(listXml(['diary-2026-01-02.txt']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const keys = await listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')

    expect(keys).toEqual(['diary-2026-01-01.txt', 'diary-2026-01-02.txt'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondRequest: Request = fetchMock.mock.calls[1][0]
    expect(secondRequest.url).toContain('continuation-token=tok-1')
  })

  it('stops after a bounded number of pages even if S3 keeps claiming truncation', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(listXml(['diary-2026-01-01.txt'], { truncated: true, nextToken: 'tok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const keys = await listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')

    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(keys).toHaveLength(10)
  })

  it('unescapes XML entities in keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(listXml(['diary-2026-01-01&amp;copy.txt']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const keys = await listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')

    expect(keys).toEqual(['diary-2026-01-01&copy.txt'])
  })

  it('returns an empty array when nothing matches the prefix', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(listXml([]), { status: 200 })))

    expect(await listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')).toEqual([])
  })

  it('throws S3Error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })))

    await expect(listObjectKeys(creds, 'my-bucket', 'us-east-1', 'diary-')).rejects.toBeInstanceOf(S3Error)
  })
})

describe('deleteObject', () => {
  it('DELETEs the object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await deleteObject(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt')

    expect((fetchMock.mock.calls[0][0] as Request).method).toBe('DELETE')
  })

  it('treats 404 as success (already gone)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))

    await expect(deleteObject(creds, 'my-bucket', 'us-east-1', 'k')).resolves.toBeUndefined()
  })

  it('throws S3Error on other failures', async () => {
    // 403, not 5xx/429: aws4fetch's AwsClient retries those internally with backoff,
    // which would make this assertion exercise a many-second retry loop instead of
    // the error path itself.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 403 })))

    await expect(deleteObject(creds, 'my-bucket', 'us-east-1', 'k')).rejects.toBeInstanceOf(S3Error)
  })
})

describe('describeError', () => {
  it('extracts the message from an XML S3Error body', () => {
    const e = new S3Error(403, '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>')
    expect(describeError(e)).toBe('Access Denied')
  })

  it('extracts the message from a JSON error body', () => {
    const e = new S3Error(400, '{"message": "Invalid request"}')
    expect(describeError(e)).toBe('Invalid request')
  })

  it('falls back to the raw message when no pattern matches', () => {
    const e = new S3Error(500, 'totally unstructured failure text')
    expect(describeError(e)).toBe('totally unstructured failure text')
  })

  it('truncates to 200 characters', () => {
    const e = new S3Error(500, 'x'.repeat(300))
    expect(describeError(e)).toBe(`${'x'.repeat(200)}…`)
  })

  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('plain failure'))).toBe('plain failure')
  })

  it('returns a generic message for a non-Error value', () => {
    expect(describeError('weird')).toBe('Unknown error')
  })
})
