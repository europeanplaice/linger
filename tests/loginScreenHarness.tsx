import { createRoot } from 'react-dom/client'
import { LoginScreen } from '../src/components/LoginScreen'
import { I18nProvider } from '../src/i18n'
import { startSignIn } from '../src/api/auth'
import type { AuthErrorCode } from '../src/hooks/useAuth'
import '../src/styles.css'

const root = createRoot(document.getElementById('root') as HTMLElement)

interface AppProps {
  tokenExpired?: boolean
  authError?: AuthErrorCode | null
}

window.loginScreenHarness = {
  render: ({ tokenExpired, authError }: AppProps = {}) => {
    root.render(
      <I18nProvider>
        <LoginScreen
          onSignIn={() => { void startSignIn().catch(() => {}) }}
          onUseAnotherAccount={() => { void startSignIn({ selectAccount: true }).catch(() => {}) }}
          tokenExpired={tokenExpired}
          authError={authError}
          onDismissAuthError={() => { window.loginScreenHarness.dismissedAuthError = true }}
          key={Date.now()}
        />
      </I18nProvider>
    )
  },
  dismissedAuthError: false,
}
