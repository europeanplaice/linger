import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'

interface Props {
  busy: boolean
  error: string | null
  onSetup: () => void
  onUnlock: () => void
  onRecover: (text: string) => Promise<void>
  onClearError?: () => void
}

/** Passkey setup/unlock happens before Google OAuth so its popup remains a direct user gesture. */
export function PasskeyGate({ busy, error, onSetup, onUnlock, onRecover, onClearError }: Props) {
  const { t, language, setLanguage } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'login' | 'setup'>('login')
  const previousView = useRef(view)
  const [fileError, setFileError] = useState(false)
  useEffect(() => {
    if (previousView.current !== view) title.current?.focus()
    previousView.current = view
  }, [view])
  const changeView = (next: typeof view) => {
    onClearError?.()
    setFileError(false)
    setView(next)
  }
  const setup = view === 'setup'
  return (
    <section className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
      <h2 ref={title} tabIndex={-1} id="passkey-gate-title">{setup ? t.login.passkeySetupTitle : t.login.passkeySignInTitle}</h2>
      <p id="passkey-gate-description">{setup ? t.login.passkeyDescription : t.login.passkeySignInDescription}</p>
      {setup && <>
        <p>{t.login.passkeyProviderHelp}</p>
        <p className="passkey-setup-note" id="passkey-setup-note">{t.login.passkeySetupNote}</p>
      </>}
      {error && <p className="session-expired-msg" role="alert">{error}</p>}
      {fileError && <p role="alert">{t.login.passkeyRecoveryFailed}</p>}
      <div className="passkey-gate-actions passkey-gate-navigation">
        <button className="btn-signin-google passkey-primary" type="button" disabled={busy}
          aria-describedby={setup ? 'passkey-gate-description passkey-setup-note' : 'passkey-gate-description'}
          onClick={setup ? onSetup : onUnlock}>
          {busy ? t.login.passkeyWorking : setup ? t.login.passkeySetup : t.login.passkeyUnlock}
        </button>
        <button className="btn-use-another-account" type="button" disabled={busy} onClick={() => changeView(setup ? 'login' : 'setup')}>
          {setup ? t.login.passkeyBackToSignIn : t.login.passkeyFirstTime}
        </button>
      </div>
      <details className="passkey-recovery-help">
        <summary>{t.login.passkeyRecover}</summary>
        <p>{t.login.passkeyRecoveryHelp}</p>
        <input ref={input} type="file" accept="application/json,.json" aria-label={t.login.passkeyRecover} disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file) return
          setFileError(false)
          if (file.size > 4096) { setFileError(true); return }
          void file.text().then(onRecover).catch(() => setFileError(true))
        }} />
      </details>
      {error && onClearError && <button className="passkey-error-dismiss" type="button" onClick={onClearError}>{t.common.close}</button>}
      <p className="login-footer">
        <a href="/home" target="_blank" rel="noopener noreferrer">{t.login.aboutLinger}</a>
        {' · '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer">{t.login.privacyPolicy}</a>
        {' · '}
        <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">{t.login.termsOfService}</a>
      </p>
      <div className="login-lang-toggle">
        <button type="button" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
        <span aria-hidden="true">·</span>
        <button type="button" aria-pressed={language === 'ja'} onClick={() => setLanguage('ja')}>日本語</button>
      </div>
      </div>
    </section>
  )
}
