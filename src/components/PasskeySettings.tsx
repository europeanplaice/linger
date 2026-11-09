import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { deletePasskey, listPasskeys } from '../api/passkeys'
import type { PasskeyCredentialSummary } from '../api/passkeys'
import { useI18n } from '../i18n'
import { clearTabSession, hasDeviceSession } from '../lib/tabSession'

export function PasskeySettings({ userId, busy, error, onAdd }: { userId: string | null; busy: boolean; error: string | null; onAdd: () => Promise<void> }) {
  const { t, language } = useI18n()
  const [credentials, setCredentials] = useState<PasskeyCredentialSummary[]>([])
  const [currentCredentialId, setCurrentCredentialId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [selected, setSelected] = useState<PasskeyCredentialSummary | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [rememberedDevice, setRememberedDevice] = useState(hasDeviceSession)
  const dialog = useRef<HTMLDialogElement>(null)

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
      if (!signal?.aborted) setListError(cause instanceof Error ? cause.message : t.login.passkeyListFailed)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [userId, t.login.passkeyListFailed])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (selected) dialog.current?.showModal()
  }, [selected])

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
      setDeleteError(cause instanceof Error ? cause.message : t.login.passkeyDeleteFailed)
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
        <Plus size={15} aria-hidden="true" />{busy ? t.login.passkeyWorking : t.login.passkeyAdd}
      </button>
    </div>
    {loading && <p role="status">{t.login.passkeyLoading}</p>}
    {listError && <p role="alert">{listError}</p>}
    {!loading && !listError && credentials.length === 0 && <p>{t.login.passkeyEmpty}</p>}
    {credentials.length > 0 && <ul className="passkey-credential-list" aria-label={t.login.passkeySavedTitle}>
      {credentials.map(credential => {
        const isCurrent = credential.credentialId === currentCredentialId
        const canDelete = !isCurrent && credentials.length > 1
        return <li key={credential.credentialId}>
          <span className="passkey-credential-icon"><KeyRound size={17} aria-hidden="true" /></span>
          <span className="passkey-credential-info">
            <span className="passkey-credential-name">{t.login.passkeyShortId} {credential.credentialId.slice(0, 8)}…</span>
            <span className="passkey-credential-date">{formatDate(credential.createdAt)}</span>
            {isCurrent && <span className="passkey-current">{t.login.passkeyCurrent}</span>}
          </span>
          {canDelete && <button className="passkey-remove-btn" type="button" disabled={busy || deleting} onClick={() => setSelected(credential)}>{t.login.passkeyRemove}</button>}
        </li>
      })}
    </ul>}
    {rememberedDevice && <button className="passkey-device-btn" type="button" onClick={() => { clearTabSession(); setRememberedDevice(false); setStatus(t.login.passkeyForgotDevice) }}>{t.login.passkeyForgetDevice}</button>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    </div>
    <dialog className="passkey-delete-dialog" ref={dialog} aria-labelledby="passkey-delete-title" onClose={() => setSelected(null)}>
      <h4 id="passkey-delete-title">{t.login.passkeyDeleteTitle}</h4>
      <p>{t.login.passkeyDeleteWarning}</p>
      {deleteError && <p role="alert">{deleteError}</p>}
      <div className="passkey-gate-actions">
        <button className="settings-copy-btn" type="button" autoFocus disabled={deleting} onClick={() => { dialog.current?.close(); setSelected(null) }}>{t.common.close}</button>
        <button className="settings-copy-btn" type="button" disabled={deleting} onClick={() => { void confirmDelete() }}>{deleting ? t.login.passkeyWorking : t.login.passkeyDeleteConfirm}</button>
      </div>
    </dialog>
  </section>
}
