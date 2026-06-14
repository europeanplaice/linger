import { AppIcon } from './AppIcon'
import { useI18n } from '../i18n'

interface Props {
  onSignIn: () => void
  onRetry?: () => void
  tokenExpired?: boolean
  authResolved?: boolean
}

export function LoginScreen({ onSignIn, onRetry, tokenExpired, authResolved }: Props) {
  const { t, language, setLanguage } = useI18n()

  const cardBody = (
    <>
        <AppIcon className="login-logo" fetchPriority="high" />
        <h1>{t.documentTitle}</h1>
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
