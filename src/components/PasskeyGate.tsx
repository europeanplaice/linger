import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'

interface Props {
  busy: boolean
  error: string | null
  onSetup: (remember: boolean) => void
  setupEmail: string | null
  onBeginSetup: () => void
  onCancelSetup: () => void
  onUnlock: (remember: boolean) => void
  onClearError?: () => void
}

export function PasskeyGate({ busy, error, onSetup, setupEmail, onBeginSetup, onCancelSetup, onUnlock, onClearError }: Props) {
  const { t, language, setLanguage } = useI18n()
  const title = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'login' | 'setup'>('login')
  const [remember, setRemember] = useState(false)
  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current !== view) title.current?.focus()
    previousView.current = view
  }, [view])
  const changeView = (next: typeof view) => {
    if (view === 'setup') onCancelSetup()
    onClearError?.()
    setView(next)
  }
  const setup = view === 'setup'
  return (
    <section className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
      <h2 ref={title} tabIndex={-1} id="passkey-gate-title">{setup ? t.login.passkeySetupTitle : t.login.passkeySignInTitle}</h2>
      <p id="passkey-gate-description">{setup ? t.login.passkeyDescription : t.login.passkeySignInDescription}</p>
      {setup && <>
        {setupEmail && <p>{setupEmail}</p>}
        <p>{t.login.passkeyProviderHelp}</p>
        <p className="passkey-setup-note" id="passkey-setup-note">{t.login.passkeySetupNote}</p>
      </>}
      {error && <p className="session-expired-msg" role="alert">{error}</p>}
      <label className="passkey-remember">
        <input type="checkbox" checked={remember} disabled={busy} aria-describedby="passkey-remember-help" onChange={event => setRemember(event.target.checked)} />
        <span>{t.login.passkeyRemember}</span>
      </label>
      <p className="passkey-remember-help" id="passkey-remember-help">{t.login.passkeyRememberHelp}</p>
      <div className="passkey-gate-actions passkey-gate-navigation">
        <button className="btn-signin-google passkey-primary" type="button" disabled={busy}
          aria-describedby={setup ? 'passkey-gate-description passkey-setup-note' : 'passkey-gate-description'}
          onClick={() => setup && !setupEmail ? onBeginSetup() : (setup ? onSetup : onUnlock)(remember)}>
          {busy ? t.login.passkeyWorking : setup ? (setupEmail ? t.login.passkeySetup : t.login.passkeyConnectGoogle) : t.login.passkeyUnlock}
        </button>
        <button className="btn-use-another-account" type="button" disabled={busy} onClick={() => changeView(setup ? 'login' : 'setup')}>
          {setup ? t.login.passkeyBackToSignIn : t.login.passkeyFirstTime}
        </button>
      </div>
      <p className="passkey-recovery-help">{t.login.passkeyRecoveryHelp}</p>
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
