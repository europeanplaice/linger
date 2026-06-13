import type { Anniversary } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

export async function loadAnniversaries(): Promise<Anniversary[]> {
  const { data } = await apiFetch<unknown>('/api/drive/anniversaries', undefined, [404])
  if (Array.isArray(data)) {
    return data.filter((item): item is Anniversary =>
      typeof item === 'object' && item !== null
      && typeof (item as Anniversary).id === 'string'
      && typeof (item as Anniversary).label === 'string'
      && typeof (item as Anniversary).monthDay === 'string',
    )
  }
  return []
}

export async function saveAnniversaries(list: Anniversary[]): Promise<void> {
  await apiFetch('/api/drive/anniversaries', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  })
}
