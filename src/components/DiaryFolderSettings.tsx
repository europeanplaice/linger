import { useEffect, useId, useRef, useState } from 'react'
import { listDiaryFolders, inspectDiaryFolder, selectDiaryFolder, DiaryFolderError, type DiaryFolderCandidate, type DiaryFolderInspection } from '../api/diaryFolders'
import { TokenExpiredError } from '../api/driveEntries'
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
    description: 'Choose the existing Google Drive folder that contains your diary. The selected folder will be used by your Linger account on all devices.',
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
    choose: 'Choose a folder',
    impact: 'Existing files stay in their folders. Switching does not move or merge diaries. Backup settings will be loaded from the selected folder.',
    inspect: 'Checking diary files and write access…',
    inspectError: 'Could not check this folder. Refresh the folders and try again.',
    open: 'Open in Google Drive',
    count: 'Visible diary files',
    range: 'Diary dates',
    modified: 'Folder updated',
    writable: 'New diary entries can be saved here.',
    readOnly: 'You cannot save new diary entries in this folder. Choose a folder you can write to.',
    noEntries: 'No diary files visible to Linger were found. Check the folder in Drive before continuing.',
    allowEmpty: 'Use this folder for new diary entries',
    busy: 'A diary save or backup is in progress. Wait for it to finish, then try again.',
    permission: 'Linger cannot access this folder. Check its Google Drive permissions, then refresh.',
    unavailable: 'This folder is no longer available. Check whether it was deleted or moved to the trash, then refresh.',
    expired: 'Your session has expired. Sign in again before choosing a folder.',
    rateLimited: 'Google Drive is receiving too many requests. Wait a moment and try again.',
    emptyChanged: 'No diary files were found. Refresh and confirm using this folder for new entries.',
    shared: 'This folder is shared. People with access to it may be able to read diary entries saved here.',
    sharingUnknown: 'Linger could not verify that this folder is private. Check its sharing settings in Google Drive.',
    allowSharing: 'Use this folder with its current sharing settings',
    sharingChanged: 'The sharing status needs confirmation. Review it and try again.',
  },
  ja: {
    title: '既存の日記フォルダに接続',
    description: '日記が入っている既存の Google Drive フォルダを選択してください。この Linger アカウントの接続先が、他の端末でもこのフォルダに変わります。',
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
    choose: 'フォルダを選択',
    impact: '既存のファイルは元の場所に残ります。日記の移動・統合は行いません。バックアップ設定は選択先のフォルダから読み込みます。',
    inspect: '日記ファイルと書き込み権限を確認中…',
    inspectError: 'フォルダを確認できませんでした。フォルダを再読み込みしてお試しください。',
    open: 'Google Drive で開く',
    count: '読み取れる日記ファイル数',
    range: '日記の日付範囲',
    modified: 'フォルダの更新日時',
    writable: 'このフォルダに新しい日記を保存できます。',
    readOnly: 'このフォルダには新しい日記を保存できません。書き込み可能なフォルダを選択してください。',
    noEntries: 'Linger から読み取れる日記ファイルが見つかりません。接続前に Drive で内容を確認してください。',
    allowEmpty: 'このフォルダを新しい日記の保存先として使う',
    busy: '日記の保存またはバックアップが進行中です。完了してからもう一度お試しください。',
    permission: 'フォルダにアクセスできません。Google Drive のアクセス権を確認して再読み込みしてください。',
    unavailable: 'フォルダが見つかりません。削除やゴミ箱への移動を確認して再読み込みしてください。',
    expired: '認証の有効期限が切れました。もう一度ログインしてからフォルダを選択してください。',
    rateLimited: 'Google Drive へのアクセスが集中しています。少し待ってからお試しください。',
    emptyChanged: '日記ファイルが見つかりません。再読み込みして、新しい日記の保存先として使うことを確認してください。',
    shared: 'このフォルダは共有されています。アクセス権のある人が、ここに保存した日記を読める場合があります。',
    sharingUnknown: 'このフォルダが非公開か確認できません。Google Drive で共有設定をご確認ください。',
    allowSharing: '現在の共有設定でこのフォルダを使用する',
    sharingChanged: '共有状態を確認してください。内容を確認してから、もう一度お試しください。',
  },
} as const

export function DiaryFolderSettings({ disabled = false, beforeSelect, onSelected }: DiaryFolderSettingsProps) {
  const { language } = useI18n()
  const copy = COPY[language === 'ja' ? 'ja' : 'en']
  const selectId = useId()
  const [folders, setFolders] = useState<DiaryFolderCandidate[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [inspection, setInspection] = useState<DiaryFolderInspection | null>(null)
  const [checking, setChecking] = useState(false)
  const [allowEmpty, setAllowEmpty] = useState(false)
  const [allowSharing, setAllowSharing] = useState(false)
  const [inspectionRevision, setInspectionRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const mounted = useRef(false)
  const refreshAbort = useRef<AbortController | null>(null)
  const selectAbort = useRef<AbortController | null>(null)

  const errorMessage = (error: unknown, fallback: string) => {
    if (error instanceof TokenExpiredError) return copy.expired
    if (!(error instanceof DiaryFolderError)) return fallback
    switch (error.code) {
      case 'busy': return copy.busy
      case 'read_only': return copy.readOnly
      case 'permission_denied': return copy.permission
      case 'unavailable': return copy.unavailable
      case 'rate_limited': return copy.rateLimited
      case 'empty_folder': return copy.emptyChanged
      case 'sharing_confirmation': return copy.sharingChanged
      default: return fallback
    }
  }

  const refresh = async () => {
    refreshAbort.current?.abort()
    const controller = new AbortController()
    refreshAbort.current = controller
    setLoading(true)
    setSelectedFolderId('')
    setInspection(null)
    setError(null)
    setStatus(null)
    try {
      const result = await listDiaryFolders(controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      setFolders(result.folders)
      setCurrentFolderId(result.selectedFolderId)
      setSelectedFolderId(result.selectedFolderId && result.folders.some(folder => folder.id === result.selectedFolderId)
        ? result.selectedFolderId
        : '')
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(errorMessage(error, copy.loadError))
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

  useEffect(() => {
    const controller = new AbortController()
    setInspection(null)
    setAllowEmpty(false)
    setAllowSharing(false)
    setChecking(Boolean(selectedFolderId))
    if (selectedFolderId) {
      void inspectDiaryFolder(selectedFolderId, controller.signal).then(result => {
        if (!controller.signal.aborted) setInspection(result)
      }).catch(error => {
        if (!controller.signal.aborted) setError(errorMessage(error, copy.inspectError))
      }).finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    }
    return () => controller.abort()
  }, [selectedFolderId, inspectionRevision])

  const candidate = inspection?.id === selectedFolderId ? inspection : null
  const sharing = candidate?.sharing ?? 'unknown'
  const sharingNeedsConfirmation = sharing !== 'private'
  const canSelect = !disabled && !saving && !loading && !checking && candidate?.canAddChildren
    && (candidate.entryCount > 0 || allowEmpty) && (!sharingNeedsConfirmation || allowSharing)
    && selectedFolderId !== currentFolderId

  const chooseFolder = async () => {
    if (!selectedFolderId || !canSelect) return
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
      const result = await selectDiaryFolder(selectedFolderId, controller.signal, allowEmpty, sharing !== 'private' ? sharing : undefined)
      if (!mounted.current || controller.signal.aborted) return
      setCurrentFolderId(result.selectedFolderId)
      setStatus(copy.success)
      await onSelected?.()
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setError(errorMessage(error, copy.selectError))
        if (error instanceof DiaryFolderError && error.code === 'sharing_confirmation') setInspectionRevision(revision => revision + 1)
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setSaving(false)
    }
  }

  return <section className="settings-section" aria-labelledby="diary-folder-settings-title">
    <h4 className="settings-section-title" id="diary-folder-settings-title">{copy.title}</h4>
    <p className="settings-section-description">{copy.description}</p>
    <p className="settings-section-description" id={`${selectId}-impact`}>{copy.impact} {copy.signIn}</p>
    {folders.length > 0 && <div className="settings-item settings-folder-choice">
      <div className="settings-item-copytext">
        <label className="settings-item-description" htmlFor={selectId}>{copy.label}</label>
        <select
          id={selectId}
          className="settings-text-input"
          aria-describedby={`${selectId}-impact ${selectId}-details`}
          value={selectedFolderId}
          disabled={disabled || loading || saving}
          onChange={event => { setSelectedFolderId(event.target.value); setStatus(null); setError(null) }}
        >
          <option value="" disabled>{copy.choose}</option>
          {folders.map(folder => <option key={folder.id} value={folder.id}>
            {folder.name} (…{folder.id.slice(-8)}){folder.id === currentFolderId ? ` · ${copy.current}` : ''}
          </option>)}
        </select>
      </div>

    </div>}
    <div id={`${selectId}-details`} aria-busy={checking}>
      {checking && <p className="settings-section-description">{copy.inspect}</p>}
      {selectedFolderId && <p className="settings-section-description">
        <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(selectedFolderId)}`} target="_blank" rel="noopener noreferrer">{copy.open}</a>
      </p>}
      {candidate && <>
        <p className="settings-section-description">{copy.count}: {candidate.entryCount}
          {candidate.firstEntryDate && candidate.lastEntryDate && <><br />{copy.range}: {candidate.firstEntryDate} – {candidate.lastEntryDate}</>}
          {candidate.modifiedTime && !Number.isNaN(Date.parse(candidate.modifiedTime)) && <><br />{copy.modified}: {new Date(candidate.modifiedTime).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}</>}
        </p>
        <p className="settings-section-description">{candidate.canAddChildren ? copy.writable : copy.readOnly}</p>
        {sharingNeedsConfirmation && <>
          <p className="settings-section-description" role="status">{sharing === 'shared' ? copy.shared : copy.sharingUnknown}</p>
          {candidate.canAddChildren && selectedFolderId !== currentFolderId && <label className="settings-folder-confirm">
            <input type="checkbox" checked={allowSharing} disabled={disabled || saving} onChange={event => setAllowSharing(event.target.checked)} />
            <span>{copy.allowSharing}</span>
          </label>}
        </>}
        {candidate.entryCount === 0 && <>
          <p className="settings-section-description">{copy.noEntries}</p>
          {candidate.canAddChildren && selectedFolderId !== currentFolderId && <label className="settings-folder-confirm">
            <input type="checkbox" checked={allowEmpty} disabled={disabled || saving} onChange={event => setAllowEmpty(event.target.checked)} />
            <span>{copy.allowEmpty}</span>
          </label>}
        </>}
      </>}
    </div>
    {loading && <p className="settings-section-description" role="status">{copy.loading}</p>}
    {!loading && folders.length === 0 && <p className="settings-section-description">{copy.empty}</p>}
    <div className="passkey-gate-actions">
      {folders.length > 0 && <button className="settings-copy-btn" type="button" disabled={!canSelect} onClick={() => void chooseFolder()}>
        {saving ? copy.selecting : copy.select}
      </button>}
      <button className="settings-copy-btn" type="button" disabled={disabled || loading || saving} onClick={() => void refresh()}>{copy.refresh}</button>
    </div>
    {error && <p className="settings-section-description" role="alert">{error}</p>}
    {status && <p className="settings-section-description" role="status">{status}</p>}
  </section>
}
