import { apiFetch } from './driveEntries'
import type { DiaryFolderSharing } from '../types'

export interface DiaryFolderCandidate {
  id: string
  name: string
  modifiedTime?: string
}

export interface DiaryFoldersResponse {
  folders: DiaryFolderCandidate[]
  selectedFolderId: string | null
}

export interface DiaryFolderInspection extends DiaryFolderCandidate {
  canAddChildren: boolean
  sharing: DiaryFolderSharing
  entryCount: number
  firstEntryDate: string | null
  lastEntryDate: string | null
}

export class DiaryFolderError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'DiaryFolderError' }
}

async function folderRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const result = await apiFetch<T & { code?: string }>(url, init, [400, 403, 404, 409, 422, 429, 503])
  if (result.status >= 400) throw new DiaryFolderError(result.data?.code ?? 'failed')
  return result.data
}

export async function listDiaryFolders(signal?: AbortSignal): Promise<DiaryFoldersResponse> {
  return folderRequest<DiaryFoldersResponse>('/api/drive/folders', { signal })
}

export async function inspectDiaryFolder(folderId: string, signal?: AbortSignal): Promise<DiaryFolderInspection> {
  return folderRequest<DiaryFolderInspection>(`/api/drive/folders?folderId=${encodeURIComponent(folderId)}`, { signal })
}

export async function getCurrentDiaryFolderSharing(signal: AbortSignal): Promise<DiaryFolderSharing | null> {
  const result = await folderRequest<{ sharing: DiaryFolderSharing | null }>('/api/drive/folders?sharing=1', { signal })
  return result.sharing ?? null
}

export async function selectDiaryFolder(
  folderId: string, signal?: AbortSignal, allowEmpty = false, acknowledgeSharing?: Exclude<DiaryFolderSharing, 'private'>,
): Promise<{ selectedFolderId: string }> {
  return folderRequest<{ selectedFolderId: string }>('/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, allowEmpty, acknowledgeSharing }),
    signal,
  })
}
