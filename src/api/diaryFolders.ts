import { apiFetch } from './driveEntries'

export interface DiaryFolderCandidate {
  id: string
  name: string
  modifiedTime?: string
}

export interface DiaryFoldersResponse {
  folders: DiaryFolderCandidate[]
  selectedFolderId: string | null
}

export async function listDiaryFolders(signal?: AbortSignal): Promise<DiaryFoldersResponse> {
  return (await apiFetch<DiaryFoldersResponse>('/api/drive/folders', { signal })).data
}

export async function selectDiaryFolder(folderId: string, signal?: AbortSignal): Promise<{ selectedFolderId: string }> {
  return (await apiFetch<{ selectedFolderId: string }>('/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
    signal,
  })).data
}
