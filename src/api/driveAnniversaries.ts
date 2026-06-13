import { normalizeAnniversaries, type Anniversary } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

export async function loadAnniversaries(): Promise<Anniversary[]> {
  const { data } = await apiFetch<unknown>('/api/drive/anniversaries', undefined, [404])
  return normalizeAnniversaries(data)
}

export async function saveAnniversaries(list: Anniversary[]): Promise<void> {
  await apiFetch('/api/drive/anniversaries', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  })
}
