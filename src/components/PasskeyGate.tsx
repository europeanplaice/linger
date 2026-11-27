import { useI18n } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { AppIcon } from './AppIcon'
import { authFeedback } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'
import type { RememberDays } from '../lib/tabSession'
import type { SavedSessionConnection } from '../hooks/useAuth'
import { Turnstile } from './Turnstile'

interface Props {
  busy: boolean
  error: string | null
  onSetup: (remember: RememberDays, recovery?: boolean, token?: string) => void
  setupEmail: string | null
  onBeginSetup: (recovery?: boolean) => void
  onCancelSetup: () => void
  onUnlock: (remember: RememberDays, preferImmediate?: boolean, token?: string | Promise<string>) => void
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
  const [token, setToken] = useState('')
  const [verificationFailed, setVerificationFailed] = useState(false)
  const pendingToken = useRef<{ resolve: (token: string) => void; reject: (error: Error) => void } | null>(null)
  const receiveToken = (value: string) => {
    if (value) setVerificationFailed(false)
    if (value && pendingToken.current) {
      pendingToken.current.resolve(value)
      pendingToken.current = null
      setToken('')
    } else setToken(value)
  }
  const failToken = () => {
    pendingToken.current?.reject(new Error('Verification unavailable'))
    pendingToken.current = null
  }
  const verificationError = () => { setVerificationFailed(true); failToken() }
  useEffect(() => () => { pendingToken.current?.reject(new Error('Verification cancelled')); pendingToken.current = null }, [])
  const [resetKey, setResetKey] = useState(0)
  const pendingReset = useRef(false)
  const sawBusy = useRef(false)
  useEffect(() => {
    if (!pendingReset.current) return
    if (busy) sawBusy.current = true
    else if (sawBusy.current) {
      failToken()
      pendingReset.current = false
      sawBusy.current = false
      setResetKey(value => value + 1)
    }
  }, [busy])
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
    let verification: string | Promise<string> = token
    if (!verification) {
      verification = new Promise<string>((resolve, reject) => { pendingToken.current = { resolve, reject } })
      void verification.catch(() => {})
    }
    onUnlock(0, preferImmediate, verification)
    setToken('')
    pendingReset.current = true
  }
  const connectGoogle = () => {
    setRecoveryConfirmed(false)
    onBeginSetup(recovery)
  }
  const progress = phase === 'google' ? t.login.googleConnecting : phase === 'create' ? t.login.passkeyCreating : phase === 'verify' ? t.login.passkeyVerifying : phase === 'restore' ? t.login.googleRestoring : t.login.passkeyWorking
  const currentStep = !setupEmail ? 0 : phase === 'verify' ? 2 : 1
  return (
    <section id="top" className="login-screen passkey-gate" aria-labelledby="passkey-gate-title">
      <div className="login-card passkey-gate-card">
        {!restoringSession && <AppIcon className="login-logo passkey-gate-logo" fetchPriority="high" />}
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
                <p>{t.login.passkeyRecoveryNext}</p>
                <label className="passkey-remember"><input type="checkbox" checked={recoveryConfirmed} disabled={busy} aria-describedby="passkey-recovery-help" onChange={event => setRecoveryConfirmed(event.target.checked)} /><span>{t.login.passkeyRecoveryConfirm}</span></label>
              </>}
            </> : !recovery && <p className="passkey-setup-note" id="passkey-setup-note">{t.login.passkeySetupNote}</p>}
          </>}
          {error && !(options && error === 'cancelled') && <p className={`session-expired-msg${error === 'cancelled' ? ' neutral' : ''}`} role={error === 'cancelled' ? 'status' : 'alert'}>{authFeedback(error, t.login)}</p>}
          <p className="passkey-progress" role="status">{busy ? progress : ''}</p>
          {!staticPreview && (!setup || setupEmail) && (
            <div className="passkey-gate-turnstile">
              <Turnstile key={setup ? 'register' : 'login'} action={setup ? 'register' : 'login'} onToken={receiveToken} onFailure={verificationError} resetKey={resetKey} language={language} />
            </div>
          )}
          <div className="passkey-gate-actions passkey-gate-navigation">
            {setup ? <>
              <button className="btn-signin-google passkey-primary" type="button" disabled={staticPreview || busy || (!!setupEmail && verificationFailed) || (!!setupEmail && !token) || (recovery && !!setupEmail && !recoveryConfirmed)}
                aria-describedby={setupEmail ? 'passkey-verify-help' : !recovery ? 'passkey-gate-description passkey-setup-note' : 'passkey-gate-description'}
                aria-busy={busy}
                onClick={() => setupEmail ? (onSetup(0, recovery, token), setToken(''), pendingReset.current = true) : connectGoogle()}>
                {setupEmail ? (recovery ? t.login.passkeyRecoveryCreate : t.login.passkeySetup) : t.login.passkeyConnectGoogle}
              </button>
              {setupEmail && <button className="btn-use-another-account" type="button" disabled={busy} onClick={connectGoogle}>{t.login.passkeyChooseGoogle}</button>}
              <button className="btn-use-another-account" type="button" disabled={staticPreview || busy} onClick={() => changeView('welcome')}>
                {t.login.passkeyBackToSignIn}
              </button>
            </> : <>
              <div className="passkey-action-group">
                <span className="passkey-action-hint">{t.login.passkeyReturningHint}</span>
                <button className="btn-signin-google passkey-primary" type="button" disabled={staticPreview || busy || verificationFailed}
                  aria-describedby="passkey-gate-description"
                  aria-busy={busy}
                  onClick={() => unlock(!options)}>
                  {t.login.passkeyUnlock}
                </button>
              </div>
              <div className="passkey-action-group">
                <span className="passkey-action-hint">{t.login.passkeyNewUserHint}</span>
                <button className={`passkey-secondary${!options ? ' passkey-get-started' : ''}`} type="button" disabled={staticPreview || busy} onClick={() => changeView('setup')}>
                  {t.login.passkeyFirstTime}
                </button>
              </div>
            </>}
          </div>
          {!setup && <>
            <details className="passkey-recovery-help passkey-about-help">
              <summary>{t.login.passkeyAboutTitle}</summary>
              <h2>{t.login.passkeyAboutWhatTitle}</h2>
              <p>{t.login.passkeyAboutWhatBody}</p>
              <h2>{t.login.passkeyAboutWhyTitle}</h2>
              <p>{t.login.passkeyAboutWhyBody}</p>
            </details>
            <details className="passkey-recovery-help">
              <summary>{t.login.passkeyRecoveryTitle}</summary>
              <h2>{t.login.passkeyOtherDeviceTitle}</h2>
              <p>{t.login.passkeyOtherDeviceHelp}</p>
              <button type="button" className="btn-use-another-account" disabled={staticPreview || busy || verificationFailed} onClick={() => unlock(false)}>{t.login.passkeyOtherDeviceAction}</button>
              <h2>{t.login.passkeyLostTitle}</h2>
              <p>{t.login.passkeyRecoveryAccountHelp}</p>
              <button type="button" className="btn-use-another-account" disabled={staticPreview || busy} onClick={() => changeView('recovery')}>{t.login.passkeyRecoveryStart}</button>
            </details>
          </>}
          {error && !(options && error === 'cancelled') && onClearError && <button className="passkey-error-dismiss" type="button" onClick={() => { if (options) setView('options'); onClearError() }}>{t.common.close}</button>}
        </>}
        <p className="login-footer">
          <a href="#about">{t.login.aboutLinger}</a>
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
      {!restoringSession && !setup && !options && (
        <a className="landing-scroll-cue" href="#screenshots">
          <span>{t.login.scrollToDetails}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </a>
      )}
    </section>
  )
}
