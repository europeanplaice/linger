import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from './i18n'
import { Landing } from './components/Landing'
import { PasskeyGate } from './components/PasskeyGate'

const noop = () => {}

// Rendered at build time and injected into dist/index.html so `/` serves real,
// crawlable marketing content in its initial HTML (see the `prerender-landing`
// plugin in vite.config.ts). The client re-renders the same Landing over it.
export function renderLanding(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLanguage="en">
      <Landing onSignIn={noop} passkeyGate={
        <PasskeyGate staticPreview busy={false} error={null} setupEmail={null}
          onSetup={noop} onBeginSetup={noop} onCancelSetup={noop} onUnlock={noop} />
      } />
    </I18nProvider>,
  )
}
