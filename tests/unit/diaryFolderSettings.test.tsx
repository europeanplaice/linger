import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DiaryFolderSettings } from '../../src/components/DiaryFolderSettings'
import { I18nProvider } from '../../src/i18n'
import * as foldersApi from '../../src/api/diaryFolders'

vi.mock('../../src/api/diaryFolders', () => ({
  listDiaryFolders: vi.fn(),
  selectDiaryFolder: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(foldersApi.listDiaryFolders).mockResolvedValue({
    folders: [{ id: 'renamed-folder', name: 'Old journal' }], selectedFolderId: null,
  })
  vi.mocked(foldersApi.selectDiaryFolder).mockResolvedValue({ selectedFolderId: 'renamed-folder' })
})

function renderSettings(props: React.ComponentProps<typeof DiaryFolderSettings> = {}) {
  return render(<I18nProvider initialLanguage="en"><DiaryFolderSettings {...props} /></I18nProvider>)
}

describe('DiaryFolderSettings', () => {
  it('checks local save safety before posting a folder choice', async () => {
    const beforeSelect = vi.fn().mockResolvedValue(false)
    renderSettings({ beforeSelect })

    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Save or sync pending diary changes')
    expect(beforeSelect).toHaveBeenCalledOnce()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })

  it('waits for the post-selection callback before leaving the connecting state', async () => {
    let finish!: () => void
    const callbackGate = new Promise<void>(resolve => { finish = resolve })
    const onSelected = vi.fn(async () => { await callbackGate })
    renderSettings({ onSelected })

    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
    expect((await screen.findByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(foldersApi.selectDiaryFolder).toHaveBeenCalledWith('renamed-folder', expect.any(AbortSignal))
    expect(onSelected).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Sign in again to reload your diary'))
    expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not post when the component unmounts during the local safety check', async () => {
    let finish!: (allowed: boolean) => void
    const beforeSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const rendered = renderSettings({ beforeSelect })
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(beforeSelect).toHaveBeenCalledOnce())

    rendered.unmount()
    finish(true)
    await Promise.resolve()
    expect(foldersApi.selectDiaryFolder).not.toHaveBeenCalled()
  })
})
