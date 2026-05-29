import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { AnimatePresence, MotionConfig } from 'motion/react'
import { useAuth } from './hooks/useAuth'
import { useDiary } from './hooks/useDiary'
import { useTheme } from './hooks/useTheme'
import { useFont } from './hooks/useFont'
import { useFontSize } from './hooks/useFontSize'
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate'
import { LoginScreen } from './components/LoginScreen'
import { SessionExpiredModal } from './components/SessionExpiredModal'
import { CalendarView } from './components/CalendarView'
import { EntryEditor } from './components/EntryEditor'
import { SearchBar } from './components/SearchBar'
import type { SearchBarHandle } from './components/SearchBar'
import { SettingsModal } from './components/SettingsModal'
import { RecollectionJourney } from './components/RecollectionJourney'
import { AppIcon } from './components/AppIcon'
import { todayYmd, shiftDate, weekdayLabel, diaryDateLabel } from './utils/date'
import { recollectionDatesToPrefetch, recollectionRandomCandidates } from './utils/recollectionDates'
import { TokenExpiredError, migrateExtensions } from './api/driveEntries'
import type { LoadedDiaryEntry } from './types'
import { useI18n } from './i18n'
import { LogOut } from 'lucide-react'

const DATE_HASH_RE = /^\d{4}-\d{2}-\d{2}$/
const MOBILE_MEDIA_QUERY = '(max-width: 640px)'
const FOCUS_REFRESH_MIN_MS = 1000

interface SidebarHistoryState {
  grassPufferSidebar?: boolean
}

function dateFromHash(): string | null {
  const hash = window.location.hash.slice(1)
  return DATE_HASH_RE.test(hash) ? hash : null
}

function isMobileLayout(): boolean {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches
}

function dismissActiveTextCursor() {
  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement)) return

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    const wasReadOnly = activeElement.readOnly
    activeElement.readOnly = true
    try {
      activeElement.setSelectionRange(0, 0)
    } catch {
      // Some input types do not support text selection.
    }
    activeElement.blur()
    requestAnimationFrame(() => {
      activeElement.readOnly = wasReadOnly
    })
  } else {
    activeElement.blur()
  }

  window.getSelection()?.removeAllRanges()
}

function RestoringScreen({ selectedDate, onTitleClick }: { selectedDate: string; onTitleClick: () => void }) {
  const { t, locale } = useI18n()
  const weekday = weekdayLabel(selectedDate, locale)
  const isToday = selectedDate === todayYmd()

  return (
    <div className="app restoring-app">
      <aside className="sidebar restoring-sidebar open">
        <div className="sidebar-top">
          <h1 className="app-title"><button className="app-title-btn" onClick={onTitleClick}><AppIcon className="app-title-icon" /> {t.appTitle}</button></h1>
        </div>
        <div className="restoring-search" />
        <CalendarView dates={new Set()} selectedDate={selectedDate} onSelect={() => {}} />
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
                  <span className="entry-date-label-full">{diaryDateLabel(selectedDate, true, 'long', locale, true)}</span>
                  <span className="entry-date-label-short">{diaryDateLabel(selectedDate, true, 'short', locale, true)}</span>
                  {weekday && <span className="entry-date-weekday">{weekday}</span>}
                </span>
              </h2>
              <span className="btn-day-nav restoring-header-placeholder" aria-hidden="true">›</span>
            </div>
            <div className="editor-actions">
              <span className="btn-save restoring-header-placeholder" aria-hidden="true">{t.entry.save}</span>
              <span className="btn-more restoring-header-placeholder" aria-hidden="true">···</span>
            </div>
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
  const { t, language } = useI18n()
  const {
    status,
    tokenExpired,
    hadSession,
    email,
    signIn,
    signOut,
    handleExpired,
    retryAfterExpired,
  } = useAuth()
  const { mode: themeMode, setMode: setThemeMode, toggleTheme } = useTheme()
  const { mode: fontMode, toggleFont } = useFont()
  const { fontSize, setFontSize } = useFontSize()
  const { updateAvailable: swUpdateAvailable, applyUpdate } = useServiceWorkerUpdate()
  const previewParams = new URLSearchParams(window.location.search).getAll('preview')
  const updateAvailable = swUpdateAvailable || previewParams.includes('update-banner')
  const forceEmptyState = previewParams.includes('empty-state')
  const [selectedDate, setSelectedDate] = useState(todayYmd)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem('linger_autosave') === 'true')
  const [pendingDate, setPendingDate] = useState<string | null>(null)
  const [retrySaveAfterReauth, setRetrySaveAfterReauth] = useState(false)
  const [reauthSaveResult, setReauthSaveResult] = useState<LoadedDiaryEntry | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recollectionOpen, setRecollectionOpen] = useState(false)
  const [serendipityPrefetch, setSerendipityPrefetch] = useState<[string, string] | [string] | []>([])
  const [entryRefreshSignal, setEntryRefreshSignal] = useState(0)
  const searchBarRef = useRef<SearchBarHandle>(null)
  const selectedDateRef = useRef(selectedDate)
  const editorDirtyRef = useRef(editorDirty)
  const sidebarOpenRef = useRef(sidebarOpen)
  const lastFocusRefreshRef = useRef(0)

  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    editorDirtyRef.current = editorDirty
  }, [editorDirty])

  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen
  }, [sidebarOpen])

  const isSignedIn = status === 'signedIn'
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const loadingSeenRef = useRef(false)

  const diary = useDiary(isSignedIn, email, handleExpired, useCallback((dates: string[]) => {
    if (selectedDateRef.current && dates.includes(selectedDateRef.current)) {
      setEntryRefreshSignal(v => v + 1)
    }
  }, []), selectedDate)

  useEffect(() => {
    if (!isSignedIn) {
      setInitialLoadComplete(false)
      loadingSeenRef.current = false
      lastFocusRefreshRef.current = 0
    }
  }, [isSignedIn])

  useEffect(() => {
    if (isSignedIn && diary.loading) {
      loadingSeenRef.current = true
    }
  }, [isSignedIn, diary.loading])

  useEffect(() => {
    if (isSignedIn && !diary.loading && loadingSeenRef.current && !initialLoadComplete) {
      setInitialLoadComplete(true)
    }
  }, [isSignedIn, diary.loading, initialLoadComplete])

  const migrationAttemptedRef = useRef(false)

  const diaryDatesRef = useRef(diary.dates)
  useEffect(() => { diaryDatesRef.current = diary.dates }, [diary.dates])
  const diaryGetContentRef = useRef(diary.getContent)
  useEffect(() => { diaryGetContentRef.current = diary.getContent }, [diary.getContent])

  // One-time migration of legacy `.md` diary files to `.txt`. Runs once per
  // device when any `.md` entry is detected; renamed files are picked up by the
  // next incremental Drive sync.
  useEffect(() => {
    if (!isSignedIn || !initialLoadComplete) return
    if (migrationAttemptedRef.current) return
    if (localStorage.getItem('linger_ext_migrated') === 'true') return
    if (!diary.hasLegacyMdFiles) return

    migrationAttemptedRef.current = true
    migrateExtensions()
      .then(migrated => {
        localStorage.setItem('linger_ext_migrated', 'true')
        if (migrated > 0) {
          diary.refreshEntries()
            .then(() => setEntryRefreshSignal(v => v + 1))
            .catch(() => {})
        }
      })
      .catch(() => { migrationAttemptedRef.current = false })
  }, [isSignedIn, initialLoadComplete, diary.hasLegacyMdFiles, diary.refreshEntries])

  useEffect(() => {
    if (recollectionOpen) return
    if (!initialLoadComplete) return
    const toFetch = recollectionDatesToPrefetch(diaryDatesRef.current)
    const candidates = recollectionRandomCandidates(diaryDatesRef.current)
    const shuffled = candidates.slice().sort(() => Math.random() - 0.5)
    const prefetch = shuffled.slice(0, 2) as [string, string] | [string] | []
    setSerendipityPrefetch(prefetch)
    const allToFetch = [...toFetch, ...prefetch]
    if (allToFetch.length === 0) return
    let cancelled = false
    const run = () => {
      if (!cancelled) allToFetch.forEach(d => diaryGetContentRef.current(d).catch(() => {}))
    }
    if (typeof requestIdleCallback !== 'undefined') {
      const id = requestIdleCallback(run, { timeout: 10_000 })
      return () => { cancelled = true; cancelIdleCallback(id) }
    }
    const id = setTimeout(run, 1_500)
    return () => { cancelled = true; clearTimeout(id) }
  }, [initialLoadComplete, recollectionOpen])

  useEffect(() => {
    if (!isSignedIn) return
    const nextDate = dateFromHash() ?? selectedDateRef.current
    setSelectedDate(nextDate)
    selectedDateRef.current = nextDate
  }, [isSignedIn])

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as SidebarHistoryState | null
      if (state?.grassPufferSidebar) {
        setSidebarOpen(false)
        return
      }

      const hashDate = dateFromHash()
      if (hashDate) {
        setSelectedDate(hashDate)
        selectedDateRef.current = hashDate
      }
      setSidebarOpen(false)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!editorDirtyRef.current) return
      event.preventDefault()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  useLayoutEffect(() => {
    if (!sidebarOpen || !isMobileLayout()) return
    dismissActiveTextCursor()
  }, [sidebarOpen])

  const closeSidebar = useCallback(() => {
    if (sidebarOpen) {
      history.back()
    } else {
      setSidebarOpen(false)
    }
  }, [sidebarOpen])

  const doNavigateToDate = useCallback((d: string) => {
    history.pushState(null, '', '#' + d)
    setSelectedDate(d)
    selectedDateRef.current = d
    setSidebarOpen(false)
    setPendingDate(null)
  }, [])

  const selectDate = useCallback((d: string) => {
    if (d !== selectedDateRef.current && editorDirtyRef.current) {
      setPendingDate(d)
      return
    }
    doNavigateToDate(d)
  }, [doNavigateToDate])

  const handleTitleClick = useCallback(() => {
    selectDate(todayYmd())
  }, [selectDate])

  const handlePendingNavigate = useCallback(() => {
    if (pendingDate) doNavigateToDate(pendingDate)
  }, [pendingDate, doNavigateToDate])

  const handleCancelNavigation = useCallback(() => {
    setPendingDate(null)
  }, [])

  const handleAutoSaveToggle = useCallback(() => {
    setAutoSave(prev => {
      const next = !prev
      localStorage.setItem('linger_autosave', String(next))
      return next
    })
  }, [])

  const onPrevDay = useCallback(() => {
    selectDate(shiftDate(selectedDateRef.current, -1))
  }, [selectDate])

  const onNextDay = useCallback(() => {
    selectDate(shiftDate(selectedDateRef.current, 1))
  }, [selectDate])

  const handleSignOut = useCallback(() => {
    history.replaceState(null, '', '#')
    setPendingDate(null)
    signOut()
  }, [signOut])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.repeat) {
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
          e.preventDefault()
          toggleTheme()
          return
        }
        if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
          e.preventDefault()
          toggleFont()
          return
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'K' || e.key === 'k')) {
          e.preventDefault()
          if (isMobileLayout() && !sidebarOpenRef.current) {
            setSidebarOpen(true)
            history.pushState({ grassPufferSidebar: true } as SidebarHistoryState, '')
          }
          requestAnimationFrame(() => searchBarRef.current?.focus())
          return
        }
      }
      if (!e.altKey || e.repeat) return
      if (document.activeElement instanceof HTMLInputElement) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        selectDate(shiftDate(selectedDateRef.current, -1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        selectDate(shiftDate(selectedDateRef.current, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selectDate(todayYmd())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectDate, toggleTheme, toggleFont])

  const datesSet = new Set(diary.dates)

  const handleReauth = useCallback(() => {
    retryAfterExpired()
    setRetrySaveAfterReauth(true)
  }, [retryAfterExpired])

  useEffect(() => {
    if (!isSignedIn || !retrySaveAfterReauth) return

    let cancelled = false
    diary.retryPendingSave()
      .then(result => {
        if (!cancelled && result) {
          setReauthSaveResult(result)
        }
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) return
        if (!cancelled) console.error('Pending save retry failed:', e)
      })
      .finally(() => {
        if (!cancelled) setRetrySaveAfterReauth(false)
      })

    return () => {
      cancelled = true
    }
  }, [isSignedIn, retrySaveAfterReauth, diary.retryPendingSave])

  useEffect(() => {
    if (!isSignedIn || tokenExpired || !initialLoadComplete) return

    let cancelled = false
    const refreshFromDrive = () => {
      if (document.visibilityState === 'hidden') return

      const now = Date.now()
      if (now - lastFocusRefreshRef.current < FOCUS_REFRESH_MIN_MS) return
      lastFocusRefreshRef.current = now

      diary.refreshEntries()
        .then(() => {
          if (!cancelled && !editorDirtyRef.current) {
            setEntryRefreshSignal(v => v + 1)
          }
        })
        .catch(e => {
          if (!cancelled) console.error('Drive refresh failed:', e)
        })
    }

    window.addEventListener('focus', refreshFromDrive)
    document.addEventListener('visibilitychange', refreshFromDrive)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refreshFromDrive)
      document.removeEventListener('visibilitychange', refreshFromDrive)
    }
  }, [isSignedIn, tokenExpired, initialLoadComplete, diary.refreshEntries])

  if (status === 'initializing') {
    return hadSession
      ? <RestoringScreen selectedDate={selectedDate} onTitleClick={handleTitleClick} />
      : null
  }

  if (status === 'signedOut' && !tokenExpired) {
    return (
      <LoginScreen
        onSignIn={signIn}
        onRetry={retryAfterExpired}
        tokenExpired={tokenExpired}
      />
    )
  }

  return (
    <MotionConfig reducedMotion="user">
    <a href="#main-content" className="skip-link">
      {language === 'ja' ? 'コンテンツへスキップ' : 'Skip to main content'}
    </a>
    <div className={`app${updateAvailable && !editorDirty ? ' app--has-update-banner' : ''}`}>
      {updateAvailable && !editorDirty && (
        <div className="update-banner" role="status">
          <span>{t.update.available}</span>
          <button className="update-banner-reload" onClick={applyUpdate}>
            {t.update.reload}
          </button>
        </div>
      )}
      <AnimatePresence>
        {tokenExpired && <SessionExpiredModal onReauth={handleReauth} />}
      </AnimatePresence>
      <div
        className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
        onClick={closeSidebar}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeSidebar() } }}
        role="button"
        tabIndex={sidebarOpen ? 0 : -1}
        aria-label={t.app.closeMenu}
      />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-top">
          <h1 className="app-title"><button className="app-title-btn" onClick={handleTitleClick}><AppIcon className="app-title-icon" /> {t.appTitle}</button></h1>
          <div className="sidebar-actions">
            <button className="btn-close-sidebar" onClick={closeSidebar} title={t.app.closeMenu} aria-label={t.app.closeMenu}>×</button>
            <button className="btn-signout" onClick={handleSignOut} title={t.app.signOut}><LogOut size={14} /></button>
          </div>
        </div>
        <SearchBar ref={searchBarRef} onSearch={diary.search} onSelect={selectDate} entriesLoading={diary.loading} />
        <CalendarView dates={datesSet} selectedDate={selectedDate} onSelect={selectDate} />
        {diary.error && <div className="sidebar-status error">{t.app.loadError}</div>}
        {!diary.loading && !diary.error && (initialLoadComplete && diary.dates.length === 0 || forceEmptyState) && (
          <p className="sidebar-empty-hint">{t.app.noEntriesHint}</p>
        )}
        {diary.dates.length > 0 && (
          <button className="btn-recollection" onClick={() => setRecollectionOpen(true)}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
            <span className="btn-text">{t.recollection.open}</span>
          </button>
        )}
        <div className="sidebar-bottom">
          {email && <div className="user-email" title={email}>{email}</div>}
          <button className="btn-settings" onClick={() => setSettingsOpen(true)} title={t.common.settings}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span className="btn-text">{t.common.settings}</span>
          </button>
        </div>
      </aside>
      <AnimatePresence>
        {settingsOpen && (
          <SettingsModal
            autoSave={autoSave}
            onAutoSaveToggle={handleAutoSaveToggle}
            themeMode={themeMode}
            onThemeModeChange={setThemeMode}
            fontMode={fontMode}
            onFontToggle={toggleFont}
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            dates={diary.dates}
            onExport={diary.exportAll}
            onClose={() => setSettingsOpen(false)}
            email={email ?? undefined}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {recollectionOpen && (
          <RecollectionJourney
            dates={diary.dates}
            getContent={diary.getContent}
            serendipityPrefetch={serendipityPrefetch}
            onSelect={(d) => {
              setRecollectionOpen(false)
              selectDate(d)
            }}
            onClose={() => setRecollectionOpen(false)}
          />
        )}
      </AnimatePresence>
      <main className="main" id="main-content" tabIndex={-1}>
        <EntryEditor
          date={selectedDate}
          getContent={diary.getContent}
          onSave={diary.save}
          onDelete={diary.remove}
          onMenuClick={() => {
            if (isMobileLayout()) {
              setSidebarOpen(true)
              history.pushState({ grassPufferSidebar: true } as SidebarHistoryState, '')
            }
          }}
          onDirtyChange={setEditorDirty}
          autoSave={autoSave}
          onPrevDay={onPrevDay}
          onNextDay={onNextDay}
          pendingNavDate={pendingDate}
          onPendingNavigate={handlePendingNavigate}
          onCancelNavigation={handleCancelNavigation}
          reauthSaveResult={reauthSaveResult}
          isSignedIn={!tokenExpired}
          onExpired={handleExpired}
          refreshSignal={entryRefreshSignal}
        />
      </main>
    </div>
    </MotionConfig>
  )
}
