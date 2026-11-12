import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@github/relative-time-element'
import './styles.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { registerServiceWorker } from './registerServiceWorker.ts'
import { I18nProvider } from './i18n.tsx'
import { DatabaseNotice } from './components/DatabaseNotice.tsx'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <DatabaseNotice />
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
)
