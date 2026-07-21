import { AppIcon } from './AppIcon'
import { useI18n } from '../i18n'
import type { AuthErrorCode } from '../hooks/useAuth'

interface Props {
  onSignIn: () => void
  onRetry?: () => void
  tokenExpired?: boolean
  authResolved?: boolean
  authError?: AuthErrorCode | null
  onDismissAuthError?: () => void
}

const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions'

export function LoginScreen({ onSignIn, onRetry, tokenExpired, authResolved, authError, onDismissAuthError }: Props) {
  const { t, language, setLanguage } = useI18n()

  const cardBody = (
    <>
        <AppIcon className="login-logo" fetchPriority="high" />
        <h1>{t.documentTitle}</h1>
        {authError === 'no_refresh_token' && (
          <div className="auth-error-panel" role="alert">
            <svg className="auth-error-panel-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <h2>{t.login.authErrorTitle}</h2>
            <p>{t.login.authErrorBody}</p>
            <ol className="auth-error-steps">
              <li>{t.login.authErrorStep1}</li>
              <li>{t.login.authErrorStep2}</li>
            </ol>
            <div className="auth-error-actions">
              <a
                className="btn-open-permissions"
                href={GOOGLE_PERMISSIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.login.openGooglePermissions}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
              {onDismissAuthError && (
                <button type="button" className="btn-dismiss-auth-error" onClick={onDismissAuthError}>
                  {t.login.dismiss}
                </button>
              )}
            </div>
          </div>
        )}
        <p>{t.login.privateDiary}</p>
        <p className="login-scope-note">{t.login.driveFileScope}</p>
        {tokenExpired && (
          <p className="session-expired-msg">
            {t.login.sessionExpiredShort}
            <button className="btn-retry" onClick={onRetry} type="button">
              {t.login.reauthenticate}
            </button>
          </p>
        )}
        <button className="btn-signin-google" onClick={onSignIn}>
          <svg
            className="google-logo"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            aria-hidden="true"
          >
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.35-8.16 2.35-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          {t.login.signInWithGoogle}
        </button>
        <p className="login-footer">
          <a href="/home" target="_blank" rel="noopener noreferrer">
            {t.login.aboutLinger}
          </a>
          {' · '}
          <a href="/privacy" target="_blank" rel="noopener noreferrer">
            {t.login.privacyPolicy}
          </a>
          {' · '}
          <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">
            {t.login.termsOfService}
          </a>
        </p>
        <div className="login-lang-toggle">
          <button
            type="button"
            aria-pressed={language === 'en'}
            onClick={() => setLanguage('en')}
          >
            EN
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            aria-pressed={language === 'ja'}
            onClick={() => setLanguage('ja')}
          >
            日本語
          </button>
        </div>
    </>
  )

  return (
    <main className="login-screen" {...(authResolved ? { 'data-auth-resolved': '' } : {})}>
      {/* Plain (non-animated) card so the build-time prerendered HTML stays put
          when React mounts over it — no flash before hydration. */}
      <div className="login-card">{cardBody}</div>
    </main>
  )
}
