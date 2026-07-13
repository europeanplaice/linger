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

export async function putObject(
  creds: AssumedCredentials,
  bucket: string,
  region: string,
  key: string,
  body: string,
  contentType = 'text/plain; charset=UTF-8',
): Promise<void> {
  const client = s3Client(creds, region)
  const resp = await client.fetch(objectUrl(bucket, region, key), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })
  if (!resp.ok) {
    throw new S3Error(resp.status, `S3 PutObject failed: ${await resp.text()}`)
  }
}

export async function deleteObject(creds: AssumedCredentials, bucket: string, region: string, key: string): Promise<void> {
  const client = s3Client(creds, region)
  const resp = await client.fetch(objectUrl(bucket, region, key), { method: 'DELETE' })
  if (!resp.ok && resp.status !== 404) {
    throw new S3Error(resp.status, `S3 DeleteObject failed: ${await resp.text()}`)
  }
}
