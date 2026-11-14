import { describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestPost } from '../../functions/api/drive/folders'
import * as drive from '../../functions/_shared/drive'

vi.mock('../../functions/_shared/drive', async original => ({
  ...await original<typeof import('../../functions/_shared/drive')>(),
  listDriveFolders: vi.fn(),
  inspectDriveFolder: vi.fn(),
}))

function context(request: Request, selectDiaryFolder = vi.fn().mockResolvedValue('chosen-folder')) {
  return {
    request,
    data: {
      accessToken: 'validated-access-token', idToken: 'validated-id-token', sessionId: 'session-a',
      session: { user_id: 'passkey-user-a', vault_key: 'request-vault-key', expires_at: 1234, folder_id: 'old-folder' },
    },
    env: { S3_WORKFLOW_SERVICE: { selectDiaryFolder } },
    selectDiaryFolder,
  }
}

describe('Drive diary folder recovery route', () => {
  it('lists folders visible to the authenticated request and its current pointer', async () => {
    vi.mocked(drive.listDriveFolders).mockResolvedValue([{ id: 'renamed-folder', name: 'Old journal' }])
    const ctx = context(new Request('https://example.test/api/drive/folders'))

    const response = await onRequestGet(ctx as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      folders: [{ id: 'renamed-folder', name: 'Old journal' }],
      selectedFolderId: 'old-folder',
    })
    expect(drive.listDriveFolders).toHaveBeenCalledWith('validated-access-token')
  })

  it('delegates the bounded selection to the account writer with request credentials', async () => {
    const selectDiaryFolder = vi.fn().mockResolvedValue('renamed-folder')
    const ctx = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: 'renamed-folder' }),
    }), selectDiaryFolder)

    const response = await onRequestPost(ctx as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ selectedFolderId: 'renamed-folder' })
    expect(selectDiaryFolder).toHaveBeenCalledWith({
      sessionId: 'session-a', accountKey: 'passkey-user-a', vaultKey: 'request-vault-key',
      accessToken: 'validated-access-token', expiresAt: 1234, idToken: 'validated-id-token',
      folderId: 'renamed-folder', allowEmpty: false,
    })
    expect(drive.listDriveFolders).not.toHaveBeenCalled()
  })

  it('rejects oversized bodies and propagates writer busy errors without selecting', async () => {
    const selectDiaryFolder = vi.fn()
    const oversized = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', body: JSON.stringify({ folderId: 'x'.repeat(3000) }),
    }), selectDiaryFolder)
    expect((await onRequestPost(oversized as never)).status).toBe(413)
    expect(selectDiaryFolder).not.toHaveBeenCalled()

    selectDiaryFolder.mockRejectedValueOnce(new Error('Diary activity is in progress'))
    const busy = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', body: JSON.stringify({ folderId: 'renamed-folder' }),
    }), selectDiaryFolder)
    expect((await onRequestPost(busy as never)).status).toBe(409)
  })
  it('inspects a candidate without selecting or creating a folder', async () => {
    const inspection = { id: 'candidate', name: 'Diary', canAddChildren: true, entryCount: 3, firstEntryDate: '2026-01-01', lastEntryDate: '2026-11-01' }
    vi.mocked(drive.inspectDriveFolder).mockResolvedValue(inspection)
    const ctx = context(new Request('https://example.test/api/drive/folders?folderId=candidate'))
    const response = await onRequestGet(ctx as never)
    expect(await response.json()).toEqual(inspection)
    expect(drive.inspectDriveFolder).toHaveBeenCalledWith('validated-access-token', 'candidate')
    expect(ctx.selectDiaryFolder).not.toHaveBeenCalled()
  })

  it.each([
    ['FOLDER_READ_ONLY', 403, 'read_only'],
    ['FOLDER_EMPTY', 422, 'empty_folder'],
    ['FOLDER_UNAVAILABLE', 400, 'unavailable'],
    ['FOLDER_PERMISSION_DENIED', 403, 'permission_denied'],
    ['FOLDER_RATE_LIMITED', 429, 'rate_limited'],
    ['Diary writer is busy', 409, 'busy'],
  ])('preserves actionable errors across RPC: %s', async (message, status, code) => {
    const ctx = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', body: JSON.stringify({ folderId: 'candidate' }),
    }), vi.fn().mockRejectedValue(new Error(message)))
    const response = await onRequestPost(ctx as never)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
  })

  it('forwards only a boolean empty-folder confirmation', async () => {
    const ctx = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', body: JSON.stringify({ folderId: 'candidate', allowEmpty: true }),
    }))
    expect((await onRequestPost(ctx as never)).status).toBe(200)
    expect(ctx.selectDiaryFolder).toHaveBeenCalledWith(expect.objectContaining({ allowEmpty: true }))
    const invalid = context(new Request('https://example.test/api/drive/folders', {
      method: 'POST', body: JSON.stringify({ folderId: 'candidate', allowEmpty: 'true' }),
    }))
    expect((await onRequestPost(invalid as never)).status).toBe(400)
    expect(invalid.selectDiaryFolder).not.toHaveBeenCalled()
  })

})
