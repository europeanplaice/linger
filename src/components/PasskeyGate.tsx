import { useI18n } from '../i18n'
import { useRef, useState } from 'react'

interface Props {
  busy: boolean
  error: string | null
  onSetup: () => void
  onUnlock: () => void
  onRecover: (text: string) => Promise<void>
  returning?: boolean
  onClearError?: () => void
}

/** Passkey setup/unlock happens before Google OAuth so its popup remains a direct user gesture. */
export function PasskeyGate({ busy, error, onSetup, onUnlock, onRecover, returning, onClearError }: Props) {
  const { t, language, setLanguage } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [fileError, setFileError] = useState(false)
  return (
    <section className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
      <h2 id="passkey-gate-title">{t.login.passkeyTitle}</h2>
      <p>{t.login.passkeyDescription}</p>
      <p>{t.login.passkeyProviderHelp}</p>
      {error && <p className="session-expired-msg" role="alert">{error}</p>}
      {fileError && <p role="alert">{t.login.passkeyRecoveryFailed}</p>}
      <div className="passkey-gate-actions">
        <button className="btn-signin-google" type="button" disabled={busy} onClick={returning ? onUnlock : onSetup}>
          {busy ? t.login.passkeyWorking : returning ? t.login.passkeyUnlock : t.login.passkeySetup}
        </button>
        <button className="btn-use-another-account" type="button" disabled={busy} onClick={returning ? onSetup : onUnlock}>
          {returning ? t.login.passkeySetup : t.login.passkeyUnlock}
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
