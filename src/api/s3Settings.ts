import type { S3Settings, S3EntryStatusResult } from '../types'
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

export interface S3PrecheckResult {
  ok: boolean
  collisions?: string[]
  error?: string
}

// Checks, before a first-time enable, whether the bucket already has diary-dated
// objects that the initial backfill would silently overwrite.
export async function precheckS3Settings(settings: Pick<S3Settings, 'roleArn' | 'bucket' | 'region'>): Promise<S3PrecheckResult> {
  const { data } = await apiFetch<S3PrecheckResult>('/api/s3/precheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  return data
}

// Re-runs the initial backfill for just the entries it failed on last time.
export async function retryS3Backfill(): Promise<void> {
  await apiFetch('/api/s3/backfill-retry', { method: 'POST' })
}

// Re-mirrors every entry against S3, not just previously-failed ones — catches
// individual per-save mirror misses that never made it into a failed list.
export async function resyncS3Backfill(): Promise<void> {
  await apiFetch('/api/s3/resync', { method: 'POST' })
}

// Continues a chunked backfill that was started but not yet finished. Each call
// processes at most 20 entries; the caller should invoke this repeatedly (driven
// by useS3Backfill's polling loop) until the response indicates done.
export async function continueS3Backfill(): Promise<{ ok: boolean; done?: boolean; remaining?: number }> {
  const { data } = await apiFetch<{ ok: boolean; done?: boolean; remaining?: number }>('/api/s3/backfill-continue', { method: 'POST' })
  return data
}

// Checked after a Drive save to learn whether the S3 mirror has caught up to
// `version` yet. `since` scopes stale sync errors out (see the endpoint).
export async function getS3EntryStatus(date: string, version: string, since: string): Promise<S3EntryStatusResult> {
  const { data } = await apiFetch<S3EntryStatusResult>(
    `/api/s3/entry-status/${date}?version=${encodeURIComponent(version)}&since=${encodeURIComponent(since)}`,
  )
  return data
}

// Re-mirrors just one date — the retry action on an entry's sync badge once its
// status comes back 'unconfirmed' (nothing else is going to attempt this date on
// its own). Awaited server-side (unlike backfill-retry/resync above), so it
// resolves once the retry has actually landed rather than leaving the caller to
// poll for it.
export async function retryS3EntrySync(date: string): Promise<void> {
  await apiFetch(`/api/s3/entry-resync/${date}`, { method: 'POST' })
}
