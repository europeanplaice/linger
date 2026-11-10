import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { authFeedback } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'
import type { RememberDays } from '../lib/tabSession'
import type { SavedSessionConnection } from '../hooks/useAuth'

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
  savedSessionConnection?: SavedSessionConnection
  onRetrySavedSession?: () => void
  staticPreview?: boolean
}

export function PasskeyGate({ busy, error, onSetup, setupEmail, onBeginSetup, onCancelSetup, onUnlock, onClearError, phase, savedSessionConnection = 'idle', onRetrySavedSession, staticPreview }: Props) {
  const { t, language, setLanguage } = useI18n()
  const title = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<'welcome' | 'options' | 'setup' | 'recovery'>('welcome')
  const currentView = savedSessionConnection !== 'idle' ? 'saved-session' : error === 'already_registered' || (view === 'welcome' && error) ? 'options' : view
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const focusTarget = setupEmail ? `${currentView}-account` : currentView
  const previousFocusTarget = useRef(focusTarget)
  useEffect(() => {
    if (previousFocusTarget.current !== focusTarget) title.current?.focus()
    previousFocusTarget.current = focusTarget
  }, [focusTarget])
  const changeView = (next: typeof view) => {
    if (setupEmail || currentView === 'setup' || currentView === 'recovery') onCancelSetup()
    onClearError?.()
    setView(next)
    setRecoveryConfirmed(false)
  }
  const setup = currentView === 'setup' || currentView === 'recovery'
  const recovery = currentView === 'recovery'
  const options = currentView === 'options'
  const restoringSession = currentView === 'saved-session'
  const unlock = (preferImmediate: boolean) => {
    if (busy) return
    if (!preferImmediate) setView('options')
    onClearError?.()
    onUnlock(0, preferImmediate)
  }
  const connectGoogle = () => {
    setRecoveryConfirmed(false)
    onBeginSetup(recovery)
  }
  const progress = phase === 'google' ? t.login.googleConnecting : phase === 'create' ? t.login.passkeyCreating : phase === 'verify' ? t.login.passkeyVerifying : phase === 'restore' ? t.login.googleRestoring : t.login.passkeyWorking
  const currentStep = !setupEmail ? 0 : phase === 'verify' ? 2 : 1
  return (
    <section className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
        <h1 ref={title} tabIndex={-1} id="passkey-gate-title">{restoringSession ? t.login.savedSessionTitle : recovery ? t.login.passkeyRecoverySetupTitle : setup ? t.login.passkeySetupTitle : options ? t.login.passkeyOptionsTitle : t.login.passkeySignInTitle}</h1>
        {restoringSession ? <>
          <p role="status">{savedSessionConnection === 'restoring' ? t.login.savedSessionRestoring : t.login.savedSessionUnavailable}</p>
          <button className="btn-signin-google passkey-primary" type="button" onClick={onRetrySavedSession} disabled={savedSessionConnection === 'restoring'}>{t.login.googleRetry}</button>
        </> : <>
          <p id="passkey-gate-description">{recovery ? t.login.passkeyRecoveryAccountHelp : setup ? t.login.passkeyDescription : options ? t.login.passkeyOptionsDescription : t.login.passkeySignInDescription}</p>
          {setup && <>
            <ol className="passkey-steps" aria-label={recovery ? t.login.passkeyRecoverySetupTitle : t.login.passkeySetupTitle}>
              {[t.login.passkeyStepGoogle, t.login.passkeyStepCreate, t.login.passkeyStepVerify].map((step, index) => <li key={step} aria-current={currentStep === index ? 'step' : undefined}>{step}</li>)}
            </ol>
            {setupEmail ? <>
              <p className="login-account">{t.login.googleAccount}<br /><strong>{setupEmail}</strong></p>
              <p id="passkey-verify-help">{t.login.passkeyVerifyHelp}</p>
              {recovery && <>
                <p id="passkey-recovery-help">{t.login.passkeyRecoveryHelp}</p>
                <label className="passkey-remember"><input type="checkbox" checked={recoveryConfirmed} disabled={busy} aria-describedby="passkey-recovery-help" onChange={event => setRecoveryConfirmed(event.target.checked)} /><span>{t.login.passkeyRecoveryConfirm}</span></label>
              </>}
            </> : !recovery && <p className="passkey-setup-note" id="passkey-setup-note">{t.login.passkeySetupNote}</p>}
          </>}
          {error && !(options && error === 'cancelled') && <p className={`session-expired-msg${error === 'cancelled' ? ' neutral' : ''}`} role={error === 'cancelled' ? 'status' : 'alert'}>{authFeedback(error, t.login)}</p>}
          <p className="passkey-progress" role="status">{busy ? progress : ''}</p>
          <div className="passkey-gate-actions passkey-gate-navigation">
            <button className="btn-signin-google passkey-primary" type="button" disabled={staticPreview || busy || (recovery && !!setupEmail && !recoveryConfirmed)}
              aria-describedby={setup && setupEmail ? 'passkey-verify-help' : setup && !recovery ? 'passkey-gate-description passkey-setup-note' : 'passkey-gate-description'}
              aria-busy={busy}
              onClick={() => setup ? (setupEmail ? onSetup(0, recovery) : connectGoogle()) : unlock(!options)}>
              {setup ? (setupEmail ? (recovery ? t.login.passkeyRecoveryCreate : t.login.passkeySetup) : t.login.passkeyConnectGoogle) : t.login.passkeyUnlock}
            </button>
            {setup && setupEmail && <button className="btn-use-another-account" type="button" disabled={busy} onClick={connectGoogle}>{t.login.passkeyChooseGoogle}</button>}
            <button className="btn-use-another-account" type="button" disabled={staticPreview || busy} onClick={() => changeView(setup ? 'welcome' : 'setup')}>
              {setup ? t.login.passkeyBackToSignIn : t.login.passkeyFirstTime}
            </button>
          </div>
          {!setup && <details className="passkey-recovery-help">
            <summary>{t.login.passkeyRecoveryTitle}</summary>
            <h2>{t.login.passkeyOtherDeviceTitle}</h2>
            <p>{t.login.passkeyOtherDeviceHelp}</p>
            <button type="button" className="btn-use-another-account" disabled={staticPreview || busy} onClick={() => unlock(false)}>{t.login.passkeyOtherDeviceAction}</button>
            <h2>{t.login.passkeyLostTitle}</h2>
            <p>{t.login.passkeyRecoveryAccountHelp}</p>
            <button type="button" className="btn-use-another-account" disabled={staticPreview || busy} onClick={() => changeView('recovery')}>{t.login.passkeyRecoveryStart}</button>
          </details>}
          {error && !(options && error === 'cancelled') && onClearError && <button className="passkey-error-dismiss" type="button" onClick={() => { if (options) setView('options'); onClearError() }}>{t.common.close}</button>}
        </>}
        <p className="login-footer">
          <a href="/home" target="_blank" rel="noopener noreferrer">{t.login.aboutLinger}</a>
          {' · '}
          <a href="/privacy" target="_blank" rel="noopener noreferrer">{t.login.privacyPolicy}</a>
          {' · '}
          <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">{t.login.termsOfService}</a>
        </p>
        <div className="login-lang-toggle">
          <button type="button" disabled={staticPreview} aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
          <span aria-hidden="true">·</span>
          <button type="button" disabled={staticPreview} aria-pressed={language === 'ja'} onClick={() => setLanguage('ja')}>日本語</button>
        </div>
      </div>
    </section>
  )
}
