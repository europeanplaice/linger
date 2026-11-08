import { useEffect, useId, useRef, useState } from 'react'
import { listDiaryFolders, selectDiaryFolder, type DiaryFolderCandidate } from '../api/diaryFolders'
import { useI18n } from '../i18n'
import { accountRequest } from '../lib/accountSession'

interface DiaryFolderSettingsProps {
  disabled?: boolean
  beforeSelect?: () => boolean | Promise<boolean>
  onSelected?: () => void | Promise<void>
}

const COPY = {
  en: {
    title: 'Reconnect existing diary folder',
    description: 'Choose the existing Google Drive folder that contains your diary. Selecting it reconnects this passkey to that folder.',
    label: 'Google Drive folder',
    loading: 'Loading folders…',
    refresh: 'Refresh folders',
    select: 'Use this folder',
    selecting: 'Connecting…',
    empty: 'No folders are visible to Linger. Sign in with the Google account that owns the diary, then refresh.',
    loadError: 'Could not load folders. Refresh and try again.',
    selectError: 'Could not connect to that folder. Refresh and try again.',
    blocked: 'Save or sync pending diary changes before changing folders.',
    success: 'Diary folder connected. Sign in again to reload your diary.',
    signIn: 'You will need to sign in again after selecting a folder.',
    current: 'currently connected',
  },
  ja: {
    title: '既存の日記フォルダに接続',
    description: '日記が入っている既存の Google Drive フォルダを選択してください。このパスキーをそのフォルダに再接続します。',
    label: 'Google Drive フォルダ',
    loading: 'フォルダを読み込み中…',
    refresh: 'フォルダを再読み込み',
    select: 'このフォルダを使う',
    selecting: '接続中…',
    empty: 'Linger から見えるフォルダがありません。日記を保存した Google アカウントでログインして再読み込みしてください。',
    loadError: 'フォルダを読み込めませんでした。再読み込みしてもう一度お試しください。',
    selectError: 'フォルダに接続できませんでした。再読み込みしてもう一度お試しください。',
    blocked: 'フォルダを変更する前に、未保存の日記の変更を保存または同期してください。',
    success: '日記フォルダに接続しました。日記を読み込むには、もう一度ログインしてください。',
    signIn: 'フォルダ選択後に、もう一度ログインする必要があります。',
    current: '現在接続中',
  },
} as const

export function DiaryFolderSettings({ disabled = false, beforeSelect, onSelected }: DiaryFolderSettingsProps) {
  const { language } = useI18n()
  const copy = COPY[language === 'ja' ? 'ja' : 'en']
  const selectId = useId()
  const [folders, setFolders] = useState<DiaryFolderCandidate[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const mounted = useRef(false)
  const refreshAbort = useRef<AbortController | null>(null)
  const selectAbort = useRef<AbortController | null>(null)

  const refresh = async () => {
    refreshAbort.current?.abort()
    const controller = new AbortController()
    refreshAbort.current = controller
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const result = await listDiaryFolders(controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setFolders(result.folders)
      setCurrentFolderId(result.selectedFolderId)
      setSelectedFolderId(result.selectedFolderId && result.folders.some(folder => folder.id === result.selectedFolderId)
        ? result.selectedFolderId
        : result.folders[0]?.id ?? '')
    } catch {
      if (mounted.current && !controller.signal.aborted) setError(copy.loadError)
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      refreshAbort.current?.abort()
      selectAbort.current?.abort()
    }
  }, []) // initial fetch only

  const chooseFolder = async () => {
    if (!selectedFolderId || disabled || saving) return
    const account = accountRequest()
    selectAbort.current?.abort()
    const controller = new AbortController()
    selectAbort.current = controller
    setError(null)
    setStatus(null)
    setSaving(true)
    try {
      if (beforeSelect && !(await beforeSelect())) {
        if (mounted.current) setError(copy.blocked)
        return
      }
      if (!mounted.current || controller.signal.aborted) return
      // Keep the same account across the safety check and selection request.
      account.assertCurrent()
      const result = await selectDiaryFolder(selectedFolderId, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setCurrentFolderId(result.selectedFolderId)
      setStatus(copy.success)
      await onSelected?.()
    } catch {
      if (mounted.current && !controller.signal.aborted) setError(copy.selectError)
    } finally {
      if (mounted.current && !controller.signal.aborted) setSaving(false)
    }
  }

  return <section className="settings-section" aria-labelledby="diary-folder-settings-title">
    <h4 className="settings-section-title" id="diary-folder-settings-title">{copy.title}</h4>
    <p className="settings-section-description">{copy.description}</p>
    <p className="settings-section-description">{copy.signIn}</p>
    {folders.length > 0 && <div className="settings-item">
      <div className="settings-item-copytext">
        <label className="settings-item-description" htmlFor={selectId}>{copy.label}</label>
        <select
          id={selectId}
          className="settings-text-input"
          value={selectedFolderId}
          disabled={disabled || loading || saving}
          onChange={event => { setSelectedFolderId(event.target.value); setStatus(null); setError(null) }}
        >
          {folders.map(folder => <option key={folder.id} value={folder.id}>
            {folder.name}{folder.id === currentFolderId ? ` · ${copy.current}` : ''}
          </option>)}
        </select>
      </div>
      <button className="settings-copy-btn" type="button" disabled={disabled || loading || saving || !selectedFolderId || selectedFolderId === currentFolderId} onClick={() => void chooseFolder()}>
        {saving ? copy.selecting : copy.select}
      </button>
    </div>}
    {loading && <p className="settings-section-description" role="status">{copy.loading}</p>}
    {!loading && folders.length === 0 && <p className="settings-section-description">{copy.empty}</p>}
    <div className="passkey-gate-actions">
      <button className="settings-copy-btn" type="button" disabled={disabled || loading || saving} onClick={() => void refresh()}>{copy.refresh}</button>
    </div>
    {error && <p className="settings-section-description" role="alert">{error}</p>}
    {status && <p className="settings-section-description" role="status">{status}</p>}
  </section>
}
