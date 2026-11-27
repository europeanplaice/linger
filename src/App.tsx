import { useState, useEffect, Suspense } from 'react'
import { useAuth } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import { useAccentColor } from './hooks/useAccentColor'
import { useFont } from './hooks/useFont'
import { useFontSize } from './hooks/useFontSize'
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate'
import { useDeployVersionCheck } from './hooks/useDeployVersionCheck'
import { Landing } from './components/Landing'
import { PasskeyGate } from './components/PasskeyGate'
import { RememberDevicePrompt } from './components/RememberDevicePrompt'
import { AuthenticatedApp, loadAuthenticatedApp } from './components/lazy'
import { AppIcon } from './components/AppIcon'
import { todayYmd, weekdayLabel, diaryDateLabel, diaryDateParts } from './utils/date'
import { useI18n } from './i18n'

function RestoringScreen({ selectedDate }: { selectedDate: string }) {
  const { t, locale } = useI18n()
  const weekday = weekdayLabel(selectedDate, locale)
  const dateParts = diaryDateParts(selectedDate, locale, true)
  const isToday = selectedDate === todayYmd()

  return (
    <div className="app restoring-app">
      <aside className="sidebar restoring-sidebar open">
        <div className="sidebar-top">
          <h1 className="app-title"><AppIcon className="app-title-icon" /> {t.appTitle}</h1>
        </div>
        <div className="restoring-search" />
        <div className="entry-skeleton" aria-hidden="true">
          <div className="entry-skeleton-row medium" />
          <div className="entry-skeleton-row" />
          <div className="entry-skeleton-row" />
          <div className="entry-skeleton-row" />
          <div className="entry-skeleton-row short" />
        </div>
      </aside>
      <main className="main">
        <div className="editor restoring-editor">
          <div className="editor-header">
            <div className="editor-date-group">
              <span className="btn-menu restoring-header-placeholder" aria-hidden="true">☰</span>
              <span className="btn-day-nav restoring-header-placeholder" aria-hidden="true">‹</span>
              <h2>
                <span
                  className="entry-date-text"
                  data-today={isToday || undefined}
                  aria-label={isToday ? `${diaryDateLabel(selectedDate, true, 'long', locale, true)}${weekday ? ` ${weekday}` : ''}, ${t.common.today}` : undefined}
                >
                  {dateParts.yearFirst && dateParts.year && <span className="entry-date-year">{dateParts.year}</span>}
                  <span className="entry-date-monthday">
                    {dateParts.monthDay}
                    {weekday && !(!dateParts.yearFirst && dateParts.year) && <span className="entry-date-weekday">{weekday}</span>}
                  </span>
                  {!dateParts.yearFirst && dateParts.year && (
                    <span className="entry-date-year">
                      {dateParts.year}
                      {weekday && <span className="entry-date-weekday">{weekday}</span>}
                    </span>
                  )}
                </span>
              </h2>
              <span className="btn-day-nav restoring-header-placeholder" aria-hidden="true">›</span>
            </div>
            <div className="editor-actions">
              <span className="btn-more restoring-header-placeholder" aria-hidden="true">···</span>
            </div>
          </div>
          <div className="editor-meta editor-meta--loading" aria-hidden="true">
            {isToday ? <span className="editor-meta-today">{t.common.today}</span> : null}
          </div>
          <div className="restoring-editor-body">
            <div className="entry-skeleton" aria-label={t.app.loading} aria-live="polite">
              <div className="entry-skeleton-row short" />
              <div className="entry-skeleton-row" />
              <div className="entry-skeleton-row medium" />
              <div className="entry-skeleton-row" />
              <div className="entry-skeleton-row long" />
              <div className="entry-skeleton-row medium" />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  const auth = useAuth()
  const {
    status,
    tokenExpired,
    hadSession,
    email,
    authError,
    signingIn,
    clearAuthError,
    signIn,
    retryAfterExpired,
    vaultStatus, vaultBusy, vaultError, setupPasskey, setupEmail, beginSetup, cancelSetup, unlockPasskey, lockVault, clearVaultError,
    vaultPhase, googleConnection, retryGoogleConnection, savedSessionConnection, retrySavedSession, offerRememberDevice, dismissRememberDevice,
  } = auth
  const theme = useTheme()
  const accent = useAccentColor()
  const font = useFont()
  const fontSizeControl = useFontSize()
  const [editorDirty, setEditorDirty] = useState(false)
  const [initialDate] = useState(todayYmd)
  const { triggerUpdateCheck, updatePending, dismissUpdate, applyUpdate } = useServiceWorkerUpdate(
    editorDirty,
    status !== 'signedOut' || vaultStatus === 'unlocked' || vaultBusy || signingIn || setupEmail !== null,
  )
  useDeployVersionCheck(triggerUpdateCheck)

  // The `session-restoring` class (set by an inline script in index.html when a
  // prior session exists) hides the prerendered landing before React mounts. Once
  // React owns the DOM it must come off, so a later sign-out reveals the landing.
  useEffect(() => {
    document.documentElement.classList.remove('session-restoring')
  }, [])

  // Preload the authenticated shell in parallel with session restore for
  // returning visitors so there is no extra waterfall once auth resolves.
  useEffect(() => {
    if (hadSession || vaultStatus === 'unlocked' || status === 'signedIn') {
      void loadAuthenticatedApp()
    }
  }, [hadSession, vaultStatus, status])

  const passkeyGate = vaultStatus !== 'unlocked' ? (
    <PasskeyGate phase={vaultPhase} busy={vaultBusy} error={vaultError} setupEmail={setupEmail} onBeginSetup={beginSetup} onCancelSetup={cancelSetup}
      onSetup={(remember, recovery, token) => { void setupPasskey(remember, recovery, token) }} onUnlock={(remember, preferImmediate, token) => { void unlockPasskey(remember, preferImmediate, token) }}
      onClearError={clearVaultError} savedSessionConnection={savedSessionConnection} onRetrySavedSession={retrySavedSession} />
  ) : undefined

  if (status === 'initializing') {
    // A returning session restores into the app shell; everyone else (including
    // crawlers and first-time visitors) sees the landing, which matches the
    // build-time prerendered HTML so there is no flash before React mounts.
    return hadSession
      ? <RestoringScreen selectedDate={initialDate} />
      : <Landing rememberDevicePrompt={offerRememberDevice && <RememberDevicePrompt onClose={dismissRememberDevice} />} googleConnection={googleConnection} onRetryConnection={() => { void retryGoogleConnection() }} signingIn={signingIn} email={email} passkeyGate={passkeyGate} onLockVault={vaultStatus === 'unlocked' ? lockVault : undefined} onSignIn={() => signIn()} onUseAnotherAccount={() => signIn({ selectAccount: true })} onRetry={() => retryAfterExpired()} authError={authError} onDismissAuthError={clearAuthError} />
  }

  if (status === 'signedOut' && !tokenExpired) {
    return (
      <Landing
        rememberDevicePrompt={offerRememberDevice && <RememberDevicePrompt onClose={dismissRememberDevice} />}
        googleConnection={googleConnection}
        onRetryConnection={() => { void retryGoogleConnection() }}
        signingIn={signingIn}
        email={email}
        passkeyGate={passkeyGate}
        onLockVault={vaultStatus === 'unlocked' ? lockVault : undefined}
        onSignIn={() => signIn()}
        onUseAnotherAccount={() => signIn({ selectAccount: true })}
        onRetry={() => retryAfterExpired()}
        tokenExpired={tokenExpired}
        authResolved
        authError={authError}
        onDismissAuthError={clearAuthError}
      />
    )
  }

  return (
    <Suspense fallback={<RestoringScreen selectedDate={initialDate} />}>
      <AuthenticatedApp
        auth={auth}
        theme={theme}
        accent={accent}
        font={font}
        fontSizeControl={fontSizeControl}
        editorDirty={editorDirty}
        onEditorDirtyChange={setEditorDirty}
        updatePending={updatePending}
        dismissUpdate={dismissUpdate}
        applyUpdate={applyUpdate}
      />
    </Suspense>
  )
}
