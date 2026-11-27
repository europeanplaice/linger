import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { DiaryFolderSettings } from '../../src/components/DiaryFolderSettings'
import { I18nProvider } from '../../src/i18n'
import { TokenExpiredError } from '../../src/api/driveEntries'
import * as foldersApi from '../../src/api/diaryFolders'
import { useDiaryFolderSharing } from '../../src/hooks/useDiaryFolderSharing'

vi.mock('../../src/api/diaryFolders', async original => ({
  ...await original<typeof import('../../src/api/diaryFolders')>(),
  listDiaryFolders: vi.fn(),
  inspectDiaryFolder: vi.fn(),
  selectDiaryFolder: vi.fn(),
  getCurrentDiaryFolderSharing: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(foldersApi.listDiaryFolders).mockResolvedValue({
    folders: [{ id: 'renamed-folder', name: 'Old journal' }], selectedFolderId: null,
  })
  vi.mocked(foldersApi.inspectDiaryFolder).mockResolvedValue({
    id: 'renamed-folder', name: 'Old journal', canAddChildren: true, sharing: 'private', entryCount: 2,
    firstEntryDate: '2026-01-01', lastEntryDate: '2026-11-01',
  })
  vi.mocked(foldersApi.selectDiaryFolder).mockResolvedValue({ selectedFolderId: 'renamed-folder' })
})

async function chooseCandidate() {
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'renamed-folder' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(false))
}

function renderSettings(props: React.ComponentProps<typeof DiaryFolderSettings> = {}) {
  return render(<I18nProvider initialLanguage="en"><DiaryFolderSettings {...props} /></I18nProvider>)
}

describe('DiaryFolderSettings', () => {
  it('checks local save safety before posting a folder choice', async () => {
    const beforeSelect = vi.fn().mockResolvedValue(false)
    renderSettings({ beforeSelect })

    await chooseCandidate()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Save or sync pending diary changes')
    expect(beforeSelect).toHaveBeenCalledOnce()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })

  it('waits for the post-selection callback before leaving the connecting state', async () => {
    let finish!: () => void
    const callbackGate = new Promise<void>(resolve => { finish = resolve })
    const onSelected = vi.fn(async () => { await callbackGate })
    renderSettings({ onSelected })

    await chooseCandidate()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect((await screen.findByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(foldersApi.selectDiaryFolder).toHaveBeenCalledWith('renamed-folder', expect.any(AbortSignal), false, undefined)
    expect(onSelected).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Sign in again to reload your diary'))
    expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not post when the component unmounts during the local safety check', async () => {
    let finish!: (allowed: boolean) => void
    const beforeSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const rendered = renderSettings({ beforeSelect })
    await chooseCandidate()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(beforeSelect).toHaveBeenCalledOnce())

    rendered.unmount()
    finish(true)
    await Promise.resolve()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })
  it('shows distinct IDs for same-name folders and previews dates before connecting', async () => {
    vi.mocked(foldersApi.listDiaryFolders).mockResolvedValue({
      folders: [{ id: 'renamed-folder', name: 'Diary' }, { id: 'second-unique', name: 'Diary' }], selectedFolderId: null,
    })
    renderSettings()
    await screen.findByRole('combobox')
    expect(screen.getByRole('option', { name: 'Choose a folder', selected: true })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Diary (…d-folder)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Diary (…d-unique)' })).toBeTruthy()
    await chooseCandidate()
    expect(screen.getByText(/2026-01-01 – 2026-11-01/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open in Google Drive' }).getAttribute('href')).toBe('https://drive.google.com/drive/folders/renamed-folder')
    expect(screen.getByText(/all devices/)).toBeTruthy()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })

  it('requires confirmation for a folder with no visible diary entries', async () => {
    vi.mocked(foldersApi.inspectDiaryFolder).mockResolvedValue({
      id: 'renamed-folder', name: 'Empty', canAddChildren: true, sharing: 'private', entryCount: 0, firstEntryDate: null, lastEntryDate: null,
    })
    renderSettings()
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'renamed-folder' } })
    const confirmation = await screen.findByRole('checkbox', { name: 'Use this folder for new diary entries' })
    expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(foldersApi.selectDiaryFolder).toHaveBeenCalledWith('renamed-folder', expect.any(AbortSignal), true, undefined))
  })

  it('blocks a read-only folder', async () => {
    vi.mocked(foldersApi.inspectDiaryFolder).mockResolvedValue({
      id: 'renamed-folder', name: 'Read only', canAddChildren: false, sharing: 'private', entryCount: 0, firstEntryDate: null, lastEntryDate: null,
    })
    renderSettings()
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'renamed-folder' } })
    await screen.findByText(/You cannot save new diary entries/)
    expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })

  it('requires a fresh confirmation when sharing changes before connection', async () => {
    vi.mocked(foldersApi.inspectDiaryFolder).mockResolvedValueOnce({
      id: 'renamed-folder', name: 'Diary', canAddChildren: true, sharing: 'private',
      entryCount: 1, firstEntryDate: '2026-11-01', lastEntryDate: '2026-11-01',
    }).mockResolvedValueOnce({
      id: 'renamed-folder', name: 'Diary', canAddChildren: true, sharing: 'shared',
      entryCount: 1, firstEntryDate: '2026-11-01', lastEntryDate: '2026-11-01',
    })
    vi.mocked(foldersApi.selectDiaryFolder).mockRejectedValueOnce(new foldersApi.DiaryFolderError('sharing_confirmation'))
    renderSettings()
    await chooseCandidate()
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Use this folder' })
    fireEvent.click(connect)
    const confirm = await screen.findByRole('checkbox', { name: 'Use this folder with its current sharing settings' })
    expect(screen.getByText(/This folder is shared/)).toBeTruthy()
    expect(connect.disabled).toBe(true)
    fireEvent.click(confirm)
    fireEvent.click(connect)
    await waitFor(() => expect(foldersApi.selectDiaryFolder).toHaveBeenLastCalledWith('renamed-folder', expect.any(AbortSignal), false, 'shared'))
  })


  it('ignores a stale inspection when another folder has been selected', async () => {
    let finish!: (value: foldersApi.DiaryFolderInspection) => void
    vi.mocked(foldersApi.listDiaryFolders).mockResolvedValue({
      folders: [{ id: 'renamed-folder', name: 'Old' }, { id: 'new-folder', name: 'New' }], selectedFolderId: null,
    })
    vi.mocked(foldersApi.inspectDiaryFolder)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ id: 'new-folder', name: 'New', canAddChildren: false, sharing: 'private', entryCount: 0, firstEntryDate: null, lastEntryDate: null })
    renderSettings()
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'renamed-folder' } })
    await waitFor(() => expect(foldersApi.inspectDiaryFolder).toHaveBeenCalledOnce())
    fireEvent.change(select, { target: { value: 'new-folder' } })
    await screen.findByText(/You cannot save new diary entries/)
    finish({ id: 'renamed-folder', name: 'Old', canAddChildren: true, sharing: 'private', entryCount: 99, firstEntryDate: '2020-01-01', lastEntryDate: '2026-01-01' })
    await Promise.resolve()
    expect(screen.queryByText(/Visible diary files: 99/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    [new foldersApi.DiaryFolderError('busy'), 'A diary save or backup is in progress'],
    [new foldersApi.DiaryFolderError('permission_denied'), 'Check its Google Drive permissions'],
    [new foldersApi.DiaryFolderError('unavailable'), 'no longer available'],
    [new TokenExpiredError(), 'Your session has expired'],
  ])('explains selection failures: %s', async (error, message) => {
    vi.mocked(foldersApi.selectDiaryFolder).mockRejectedValueOnce(error)
    renderSettings()
    await chooseCandidate()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect((await screen.findByRole('alert')).textContent).toContain(message)
  })

})

it('rechecks the active folder while the diary stays open', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(foldersApi.getCurrentDiaryFolderSharing).mockResolvedValueOnce('private').mockResolvedValueOnce('shared')
  try {
    const { result, rerender, unmount } = renderHook(({ userId }) => useDiaryFolderSharing(userId), {
      initialProps: { userId: 'account-a' as string | null },
    })
    await act(async () => {})
    expect(result.current).toBe('private')
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(result.current).toBe('shared')
    const signal = vi.mocked(foldersApi.getCurrentDiaryFolderSharing).mock.calls[0][0]
    rerender({ userId: null })
    expect(result.current).toBeNull()
    expect(signal.aborted).toBe(true)
    unmount()
  } finally {
    visibility.mockRestore()
    vi.useRealTimers()
  }
})
