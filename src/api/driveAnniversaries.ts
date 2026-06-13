import { isAnniversary, type Anniversary } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

export async function loadAnniversaries(): Promise<Anniversary[]> {
  const { data } = await apiFetch<unknown>('/api/drive/anniversaries', undefined, [404])
  if (Array.isArray(data)) {
    return data.filter(isAnniversary)
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
