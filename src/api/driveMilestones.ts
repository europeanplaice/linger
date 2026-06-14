import { normalizeMilestones, type Milestone } from '../types'
import { apiFetch, TokenExpiredError } from './driveEntries'

export { TokenExpiredError }

export async function loadMilestones(): Promise<Milestone[]> {
  const { data } = await apiFetch<unknown>('/api/drive/milestones', undefined, [404])
  return normalizeMilestones(data)
}

export async function saveMilestones(list: Milestone[]): Promise<void> {
  await apiFetch('/api/drive/milestones', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  })
}
