import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { deletePasskey, listPasskeys, renamePasskey } from '../api/passkeys'
import type { PasskeyCredentialSummary } from '../api/passkeys'
import { useI18n } from '../i18n'
import { clearTabSession, getDeviceSessionExpiry } from '../lib/tabSession'
import { authFeedback } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'
import { rememberDevicePromptDismissal } from '../lib/rememberDevicePrompt'
import { RememberDevicePrompt } from './RememberDevicePrompt'

export function PasskeySettings({ userId, busy, error, onAdd, phase }: { userId: string | null; busy: boolean; error: string | null; onAdd: () => Promise<void>; phase?: PasskeyPhase | null }) {
  const { t, language } = useI18n()
  const [credentials, setCredentials] = useState<PasskeyCredentialSummary[]>([])
  const [currentCredentialId, setCurrentCredentialId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [selected, setSelected] = useState<PasskeyCredentialSummary | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deviceExpiry, setDeviceExpiry] = useState(getDeviceSessionExpiry)
  const [choosingSignIn, setChoosingSignIn] = useState(false)
  const [renaming, setRenaming] = useState<PasskeyCredentialSummary | null>(null)
  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const renameDialog = useRef<HTMLDialogElement>(null)
  const signInChoiceButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const sync = () => setDeviceExpiry(getDeviceSessionExpiry())
    const timer = deviceExpiry ? setTimeout(sync, Math.max(0, deviceExpiry - Date.now())) : undefined
    window.addEventListener('storage', sync)
    window.addEventListener('focus', sync)
    return () => { clearTimeout(timer); window.removeEventListener('storage', sync); window.removeEventListener('focus', sync) }
  }, [deviceExpiry])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!userId) {
      setCredentials([])
      setCurrentCredentialId(null)
      return
    }
    setLoading(true)
    setListError(null)
    try {
      const result = await listPasskeys(userId, signal)
      if (signal?.aborted) return
      setCredentials(result.credentials)
      setCurrentCredentialId(result.currentCredentialId)
    } catch (cause) {
      if (!signal?.aborted) setListError(authFeedback(cause, t.login))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [userId, t.login])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (selected) dialog.current?.showModal()
  }, [selected])

  useEffect(() => {
    if (renaming) renameDialog.current?.showModal()
  }, [renaming])

  const saveName = async () => {
    if (!userId || !renaming || !name.trim() || savingName) return
    setSavingName(true)
    setRenameError(null)
    setStatus(null)
    try {
      await renamePasskey(userId, renaming.credentialId, name.trim())
      renameDialog.current?.close()
      setRenaming(null)
      setStatus(t.login.passkeyRenamed)
      await refresh()
    } catch (cause) { setRenameError(authFeedback(cause, t.login)) }
    finally { setSavingName(false) }
  }

  const add = async () => {
    setStatus(null)
    await onAdd()
    await refresh()
  }

  const confirmDelete = async () => {
    if (!userId || !selected) return
    setDeleting(true)
    setStatus(null)
    setListError(null)
    setDeleteError(null)
    try {
      await deletePasskey(userId, selected.credentialId)
      setStatus(t.login.passkeyDeleted)
      setSelected(null)
      dialog.current?.close()
      await refresh()
    } catch (cause) {
      setDeleteError(authFeedback(cause, t.login))
    } finally {
      setDeleting(false)
    }
  }

  const formatDate = (value: number) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en', { dateStyle: 'medium' }).format(date)
  }

  return <section className="settings-section passkey-settings" aria-labelledby="passkey-settings-title">
    <h4 className="settings-section-title" id="passkey-settings-title">{t.login.passkeyTitle}</h4>
    <p className="settings-section-description">{t.login.passkeyProviderHelp}</p>
    <div className="passkey-settings-body">
    <div className="passkey-list-heading">
      <h5>{t.login.passkeySavedTitle}</h5>
      <button className="settings-copy-btn passkey-add-btn" type="button" disabled={busy || !userId} onClick={() => { void add() }}>
        <Plus size={15} aria-hidden="true" />{busy ? (phase === 'create' ? t.login.passkeyCreating : phase === 'verify' ? t.login.passkeyVerifying : t.login.passkeyWorking) : t.login.passkeyAdd}
      </button>
    </div>
    {loading && <p role="status">{t.login.passkeyLoading}</p>}
    {listError && <p role="alert">{listError}</p>}
    {!loading && !listError && credentials.length === 0 && <p>{t.login.passkeyEmpty}</p>}
    {!loading && !listError && credentials.length === 1 && <p>{t.login.passkeyBackupHint}</p>}
    {credentials.length > 0 && <ul className="passkey-credential-list" aria-label={t.login.passkeySavedTitle}>
      {credentials.map(credential => {
        const isCurrent = credential.credentialId === currentCredentialId
        const canDelete = !isCurrent && credentials.length > 1
        return <li key={credential.credentialId}>
          <span className="passkey-credential-icon"><KeyRound size={17} aria-hidden="true" /></span>
          <span className="passkey-credential-info">
            <span className="passkey-credential-name">{credential.name || `${t.login.passkeyShortId} ${credential.credentialId.slice(0, 8)}…`}</span>
            <span className="passkey-credential-date">{t.login.passkeyCreated}: {formatDate(credential.createdAt)}</span>
            <span className="passkey-credential-date">{credential.lastUsedAt ? `${t.login.passkeyLastUsed}: ${formatDate(credential.lastUsedAt)}` : t.login.passkeyNeverUsed}</span>
            {isCurrent && <span className="passkey-current">{t.login.passkeyCurrent}</span>}
          </span>
          <div className="passkey-credential-actions">
            <button className="passkey-remove-btn" type="button" disabled={busy || deleting || savingName} onClick={() => { setName(credential.name ?? ''); setRenameError(null); setRenaming(credential) }}>{t.login.passkeyRename}</button>
            {canDelete && <button className="passkey-remove-btn" type="button" disabled={busy || deleting || savingName} onClick={() => { setDeleteError(null); setSelected(credential) }}>{t.login.passkeyRemove}</button>}
          </div>
        </li>
      })}
    </ul>}
    {deviceExpiry && <>
      <p>{t.login.passkeyRememberUntil}: {new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(deviceExpiry)}</p>
      <button className="passkey-device-btn" type="button" onClick={() => { clearTabSession(); setDeviceExpiry(null); setStatus(t.login.passkeyForgotDevice) }}>{t.login.passkeyForgetDevice}</button>
    </>}
    <button ref={signInChoiceButton} className="passkey-device-btn" type="button" disabled={busy || !userId} aria-expanded={choosingSignIn} onClick={() => setChoosingSignIn(value => !value)}>{t.login.passkeyRememberPrompt}</button>
    {choosingSignIn && <RememberDevicePrompt onClose={() => {
      rememberDevicePromptDismissal()
      setChoosingSignIn(false)
      setDeviceExpiry(getDeviceSessionExpiry())
      signInChoiceButton.current?.focus()
    }} />}
    {error && <p role={error === 'cancelled' ? 'status' : 'alert'}>{authFeedback(error, t.login)}</p>}
    {status && <p role="status">{status}</p>}
    </div>
    <dialog className="passkey-delete-dialog" ref={dialog} aria-labelledby="passkey-delete-title" onClose={() => setSelected(null)}>
      <h4 id="passkey-delete-title">{t.login.passkeyDeleteTitle}</h4>
      {selected && <p>{selected.name || `${t.login.passkeyShortId} ${selected.credentialId.slice(0, 8)}…`}</p>}
      <p>{t.login.passkeyDeleteWarning}</p>
      {deleteError && <p role="alert">{deleteError}</p>}
      <div className="passkey-gate-actions">
        <button className="settings-copy-btn" type="button" autoFocus disabled={deleting} onClick={() => { dialog.current?.close(); setSelected(null) }}>{t.common.close}</button>
        <button className="settings-copy-btn" type="button" disabled={deleting} onClick={() => { void confirmDelete() }}>{deleting ? t.login.passkeyWorking : t.login.passkeyDeleteConfirm}</button>
      </div>
    </dialog>
    <dialog className="passkey-delete-dialog" ref={renameDialog} aria-labelledby="passkey-rename-title" onClose={() => setRenaming(null)} onCancel={event => { if (savingName) event.preventDefault() }}>
      <form onSubmit={event => { event.preventDefault(); void saveName() }}>
        <h4 id="passkey-rename-title">{t.login.passkeyRename}</h4>
        <label className="passkey-name-label" htmlFor="passkey-name">{t.login.passkeyName}</label>
        <input id="passkey-name" name="passkey-name" autoComplete="off" maxLength={80} required disabled={savingName} value={name} aria-describedby="passkey-name-help" onChange={event => setName(event.target.value)} />
        <p id="passkey-name-help">{t.login.passkeyNameHelp}</p>
        {renameError && <p role="alert">{renameError}</p>}
        <div className="passkey-gate-actions">
          <button className="settings-copy-btn" type="button" disabled={savingName} onClick={() => renameDialog.current?.close()}>{t.common.cancel}</button>
          <button className="settings-copy-btn" type="submit" disabled={savingName || !name.trim()}>{savingName ? t.common.savingEllipsis : t.common.save}</button>
        </div>
      </form>
    </dialog>
  </section>
}
