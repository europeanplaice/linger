import type { S3Settings } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

export interface S3TestResult {
  ok: boolean
  error?: string
}

export async function loadS3Settings(): Promise<S3Settings | null> {
  const { data } = await apiFetch<S3Settings | null>('/api/s3/settings')
  return data
}

export async function saveS3Settings(settings: S3Settings): Promise<void> {
  await apiFetch('/api/s3/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export async function testS3Settings(settings: Pick<S3Settings, 'roleArn' | 'bucket' | 'region'>): Promise<S3TestResult> {
  const { data } = await apiFetch<S3TestResult>('/api/s3/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  return data
}
