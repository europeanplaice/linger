import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { authFeedback } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'
import type { RememberDays } from '../lib/tabSession'

interface Props {
  busy: boolean
  error: string | null
  onSetup: (remember: RememberDays, recovery?: boolean) => void
  setupEmail: string | null
  onBeginSetup: (recovery?: boolean) => void
  onCancelSetup: () => void
  onUnlock: (remember: RememberDays, preferImmediate?: boolean) => void
  phase?: PasskeyPhase | null
  onClearError?: () => void
}

export function PasskeyGate({ busy, error, onSetup, setupEmail, onBeginSetup, onCancelSetup, onUnlock, onClearError, phase }: Props) {
  const { t, language, setLanguage } = useI18n()
  const title = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'welcome' | 'options' | 'setup' | 'recovery'>('welcome')
  const currentView = error === 'already_registered' || (view === 'welcome' && error) ? 'options' : view
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const previousView = useRef(currentView)
  useEffect(() => {
    if (previousView.current !== currentView) title.current?.focus()
    previousView.current = currentView
  }, [currentView])
  const changeView = (next: typeof view) => {
    if (setupEmail || currentView === 'setup' || currentView === 'recovery') onCancelSetup()
    onClearError?.()
    setView(next)
    setRecoveryConfirmed(false)
  }
  const setup = currentView === 'setup' || currentView === 'recovery'
  const recovery = currentView === 'recovery'
  const options = currentView === 'options'
  const unlock = () => {
    if (busy) return
    if (options) setView('options')
    onClearError?.()
    onUnlock(0, !options)
  }
  const progress = phase === 'google' ? t.login.googleConnecting : phase === 'create' ? t.login.passkeyCreating : phase === 'verify' ? t.login.passkeyVerifying : phase === 'restore' ? t.login.googleRestoring : t.login.passkeyWorking
  const currentStep = !setupEmail ? 0 : phase === 'verify' ? 2 : 1
  return (
    <section className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
      <h2 ref={title} tabIndex={-1} id="passkey-gate-title">{recovery ? t.login.passkeyRecoverySetupTitle : setup ? t.login.passkeySetupTitle : options ? t.login.passkeyOptionsTitle : t.login.passkeySignInTitle}</h2>
      <p id="passkey-gate-description">{recovery ? t.login.passkeyRecoveryHelp : setup ? t.login.passkeyDescription : options ? t.login.passkeyOptionsDescription : t.login.passkeySignInDescription}</p>
      {setup && <>
        <ol className="passkey-steps" aria-label={t.login.passkeySetupTitle}>
          {[t.login.passkeyStepGoogle, t.login.passkeyStepCreate, t.login.passkeyStepVerify].map((step, index) => <li key={step} aria-current={currentStep === index ? 'step' : undefined}>{step}</li>)}
        </ol>
        {setupEmail && <p>{setupEmail}</p>}
        {(!recovery || setupEmail) && <p>{t.login.passkeyProviderHelp}</p>}
        {!recovery && <p className="passkey-setup-note" id="passkey-setup-note">{t.login.passkeySetupNote}</p>}
        <p>{t.login.passkeyVerifyHelp}</p>
        {recovery && <>
          <label className="passkey-remember"><input type="checkbox" checked={recoveryConfirmed} disabled={busy} onChange={event => setRecoveryConfirmed(event.target.checked)} /><span>{t.login.passkeyRecoveryConfirm}</span></label>
        </>}
      </>}
      {error && !(options && error === 'cancelled') && <p className={`session-expired-msg${error === 'cancelled' ? ' neutral' : ''}`} role={error === 'cancelled' ? 'status' : 'alert'}>{authFeedback(error, t.login)}</p>}
      <p className="passkey-progress" role="status">{busy ? progress : ''}</p>
      <div className="passkey-gate-actions passkey-gate-navigation">
        <button className="btn-signin-google passkey-primary" type="button" disabled={busy || (recovery && !recoveryConfirmed)}
          aria-describedby={setup && !recovery ? 'passkey-gate-description passkey-setup-note' : 'passkey-gate-description'}
          aria-busy={busy}
          onClick={() => setup && !setupEmail ? onBeginSetup(recovery) : (setup ? onSetup(0, recovery) : unlock())}>
          {setup ? (setupEmail ? t.login.passkeySetup : t.login.passkeyConnectGoogle) : options ? t.login.passkeyUnlock : t.login.passkeyOpen}
        </button>
        <button className="btn-use-another-account" type="button" disabled={busy} onClick={() => changeView(setup ? 'options' : 'setup')}>
          {setup ? t.login.passkeyBackToSignIn : t.login.passkeyFirstTime}
        </button>
      </div>
      {options && <details className="passkey-recovery-help">
        <summary>{t.login.passkeyRecoveryTitle}</summary>
        <h3>{t.login.passkeyOtherDeviceTitle}</h3>
        <p>{t.login.passkeyOtherDeviceHelp}</p>
        <h3>{t.login.passkeyLostTitle}</h3>
        <p>{t.login.passkeyRecoveryHelp}</p>
        <button type="button" className="btn-use-another-account" disabled={busy} onClick={() => changeView('recovery')}>{t.login.passkeyRecoveryStart}</button>
      </details>}
      {error && !(options && error === 'cancelled') && onClearError && <button className="passkey-error-dismiss" type="button" onClick={() => { if (options) setView('options'); onClearError() }}>{t.common.close}</button>}
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
