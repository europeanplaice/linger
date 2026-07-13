import type { S3Settings } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

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
