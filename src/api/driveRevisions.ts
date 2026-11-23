import type { DriveRevisionMeta, DiaryEntry } from '../types'
import { apiFetch, readDriveEntry, TokenExpiredError, DriveHttpError } from './driveEntries'
import { accountRequest } from '../lib/accountSession'

export type { TokenExpiredError, DriveHttpError }

const BASE = '/api/drive/revisions'

type ListRevisionsResponse = DriveRevisionMeta[] | { revisions?: DriveRevisionMeta[] }

export async function listRevisions(fileId: string): Promise<DriveRevisionMeta[]> {
  const { data } = await apiFetch<ListRevisionsResponse>(`${BASE}/${fileId}`)
  if (Array.isArray(data)) return data
  return data?.revisions ?? []
}

export async function getRevisionContent(fileId: string, revisionId: string): Promise<DiaryEntry> {
  const account = accountRequest()
  const authorize = () => apiFetch<{ ok: boolean }>(`${BASE}/${encodeURIComponent(fileId)}/${encodeURIComponent(revisionId)}?metadata=1`)
  const { data, accessToken } = await authorize()
  account.assertCurrent()
  if (!data?.ok) throw new DriveHttpError(404, 'Not found')
  const entry = await readDriveEntry(fileId, '', {
    accessToken,
    verifyRefreshedToken: async () => (await authorize()).accessToken,
  }, undefined, revisionId)
  if (!entry) throw new DriveHttpError(404, 'Not found')
  return entry
}
