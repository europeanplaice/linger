import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EntryEditor } from '../src/components/EntryEditor'
import { useOnline } from '../src/hooks/useOnline'
import { EntryConflictError } from '../src/hooks/useDiary'
import { TokenExpiredError } from '../src/api/driveEntries'
import type { LoadedDiaryEntry } from '../src/types'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

const theme = new URLSearchParams(location.search).get('theme')
if (theme) document.documentElement.setAttribute('data-theme', theme)

type SaveCall = { date: string; content: string; baseVersion: string | null; force?: boolean }
type FullSaveCall = SaveCall & { baseContent?: string | null }
type DeleteCall = { date: string }
type NavCall = { date: string | null }
type WindowOpenCall = { url: string; target: string }
type GetContentCall = { date: string }

const root = createRoot(document.getElementById('root') as HTMLElement)

let saveCalls: SaveCall[] = []
let fullSaveCalls: FullSaveCall[] = []
let deleteCalls: DeleteCall[] = []
let pendingNavigateCalls: NavCall[] = []
let cancelNavigationCalls: NavCall[] = []
let windowOpenCalls: WindowOpenCall[] = []
let getContentCalls: GetContentCall[] = []
let menuClickCount = 0
let goToTodayCount = 0
let dirtyChanges: boolean[] = []

let currentSaveReject: 'conflict' | 'error' | undefined
let currentGetContentReject: 'tokenExpired' | 'error' | undefined = undefined
let currentDeleteReject: 'error' | undefined = undefined
let currentDeleteDelayMs = 0
let expiredCount = 0
let currentToken: string | null = null
let currentSaveDelayMs = 0
let currentRemoteContent = ''
let currentRemoteVersion: string | null = null

let lastRenderDate = '2026-05-01'
let lastRenderAutoSave = true
let lastRenderGetContentDelayMs = 0
let lastRenderPendingNavDate: string | null = null
// Captures App's pendingNavDate setter so tests can request a day switch after mount.
let appSetPendingNavDate: ((d: string | null) => void) | null = null
let lastRenderKnownDates: string[] | undefined
let lastRenderDiaryListLoaded: boolean | undefined

let currentRefreshSignal = 0
const contentByDate: Map<string, { content: string; version: string | null }> = new Map()
let getContentBlockedForDate: string | null = null
let getContentBlockResolvers: Array<() => void> = []
let saveBlocked = false
let saveBlockResolvers: Array<() => void> = []

function delaySave(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Mock window.open
window.open = (url?: string | URL, target?: string) => {
  if (url) windowOpenCalls.push({ url: String(url), target: target ?? '' })
  return null
}

function doRender() {
  root.render(
    <I18nProvider>
      <App
        date={lastRenderDate}
        autoSave={lastRenderAutoSave}
        getContentDelayMs={lastRenderGetContentDelayMs}
        pendingNavDate={lastRenderPendingNavDate}
        token={currentToken}
        refreshSignal={currentRefreshSignal}
        knownDates={lastRenderKnownDates}
        diaryListLoaded={lastRenderDiaryListLoaded}
      />
    </I18nProvider>
  )
}

function App({ date, autoSave, getContentDelayMs, pendingNavDate: initialPendingNavDate, token, refreshSignal, knownDates, diaryListLoaded }: {
  date: string
  autoSave: boolean
  getContentDelayMs: number
  pendingNavDate: string | null
  token: string | null
  refreshSignal: number
  knownDates?: string[]
  diaryListLoaded?: boolean
}) {
  const [pendingNavDate, setPendingNavDate] = useState<string | null>(initialPendingNavDate)
  appSetPendingNavDate = setPendingNavDate
  const isOnline = useOnline()

  function onExpired() {
    expiredCount++
  }

  return (
    <EntryEditor
      date={date}
      autoSave={autoSave}
      refreshSignal={refreshSignal}
      knownDates={knownDates === undefined ? undefined : new Set(knownDates)}
      diaryListLoaded={diaryListLoaded}
      getContent={async (d) => {
        getContentCalls.push({ date: d })
        if (d === getContentBlockedForDate) {
          await new Promise<void>(resolve => getContentBlockResolvers.push(resolve))
        } else if (getContentDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, getContentDelayMs))
        }
        if (currentGetContentReject === 'tokenExpired') {
          onExpired()
          throw new TokenExpiredError()
        }
        if (currentGetContentReject === 'error') {
          throw new Error('Network error')
        }
        const perDate = contentByDate.get(d)
        if (perDate) {
          return {
            entry: { date: d, content: perDate.content },
            meta: { id: 'file-1', name: `diary-${d}.json`, version: perDate.version ?? undefined, modifiedTime: '2026-05-01T10:00:00.000Z' },
          }
        }
        if (!currentRemoteContent && currentRemoteVersion === null) return null
        return {
          entry: { date, content: currentRemoteContent },
          meta: { id: 'file-1', name: `diary-${date}.json`, version: currentRemoteVersion ?? undefined, modifiedTime: '2026-05-01T10:00:00.000Z' },
        }
      }}
      onSave={async (d, content, baseVer, force, baseContent) => {
        // Simulate a network failure while offline, mirroring fetch in production.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          throw new Error('Network error')
        }
        if (saveBlocked) {
          await new Promise<void>(resolve => saveBlockResolvers.push(resolve))
        }
        if (currentSaveDelayMs > 0) {
          await delaySave(currentSaveDelayMs)
        }
        saveCalls.push({ date: d, content, baseVersion: baseVer, force })
        fullSaveCalls.push({ date: d, content, baseVersion: baseVer, force, baseContent })
        if (currentSaveReject === 'conflict' && !force) {
          const remote: LoadedDiaryEntry = {
            entry: { date: d, content: 'remote content' },
            meta: { id: 'file-1', name: `diary-${d}.json`, version: '99' },
          }
          throw new EntryConflictError(remote)
        }
        if (currentSaveReject === 'error') {
          throw new Error('Network error')
        }
        currentRemoteContent = content
        currentRemoteVersion = '2'
        return {
          entry: { date: d, content },
          meta: { id: 'file-1', name: `diary-${d}.json`, version: currentRemoteVersion, modifiedTime: new Date().toISOString() },
        }
      }}
      onDelete={async (d) => {
        deleteCalls.push({ date: d })
        if (currentDeleteDelayMs > 0) await delaySave(currentDeleteDelayMs)
        if (currentDeleteReject === 'error') throw new Error('Network error')
      }}
      onMenuClick={() => { menuClickCount++ }}
      onGoToToday={() => { goToTodayCount++ }}
      onDirtyChange={(isDirty) => { dirtyChanges.push(isDirty) }}
      onPrevDay={() => {}}
      onNextDay={() => {}}
      pendingNavDate={pendingNavDate}
      onPendingNavigate={() => {
        pendingNavigateCalls.push({ date: pendingNavDate })
        setPendingNavDate(null)
      }}
      onCancelNavigation={() => {
        cancelNavigationCalls.push({ date: pendingNavDate })
        setPendingNavDate(null)
      }}
      reauthSaveResult={null}
      isSignedIn={token !== null}
      isOnline={isOnline}
      onExpired={onExpired}
    />
  )
}

window.editorHarness = {
  render: (opts: {
    date?: string
    initialContent?: string
    version?: string | null
    saveReject?: 'conflict' | 'error'
    getContentReject?: 'tokenExpired' | 'error'
    deleteReject?: 'error'
    deleteDelayMs?: number
    autoSave?: boolean
    getContentDelayMs?: number
    pendingNavDate?: string | null
    token?: string | null
    saveDelayMs?: number
    knownDates?: string[]
    diaryListLoaded?: boolean
  }) => {
    saveCalls = []
    fullSaveCalls = []
    deleteCalls = []
    pendingNavigateCalls = []
    cancelNavigationCalls = []
    windowOpenCalls = []
    getContentCalls = []
    menuClickCount = 0
    goToTodayCount = 0
    dirtyChanges = []
    currentSaveReject = opts.saveReject
    currentGetContentReject = opts.getContentReject
    currentDeleteReject = opts.deleteReject
    currentDeleteDelayMs = opts.deleteDelayMs ?? 0
    currentToken = opts.token ?? null
    currentSaveDelayMs = opts.saveDelayMs ?? 0
    saveBlocked = false
    saveBlockResolvers = []
    currentRemoteContent = opts.initialContent ?? ''
    currentRemoteVersion = opts.version ?? null
    lastRenderDate = opts.date ?? '2026-05-01'
    lastRenderAutoSave = opts.autoSave ?? true
    lastRenderGetContentDelayMs = opts.getContentDelayMs ?? 0
    lastRenderPendingNavDate = opts.pendingNavDate ?? null
    lastRenderKnownDates = opts.knownDates
    lastRenderDiaryListLoaded = opts.diaryListLoaded
    currentRefreshSignal = 0
    contentByDate.clear()
    getContentBlockedForDate = null
    getContentBlockResolvers = []
    doRender()
  },
  saveCalls: () => [...saveCalls],
  saveCallsWithBaseContent: () => [...fullSaveCalls],
  getContentCalls: () => [...getContentCalls],
  setRemoteEntry: (content, version) => {
    currentRemoteContent = content
    currentRemoteVersion = version
  },
  deleteCalls: () => [...deleteCalls],
  pendingNavigateCalls: () => [...pendingNavigateCalls],
  cancelNavigationCalls: () => [...cancelNavigationCalls],
  menuClickCount: () => menuClickCount,
  goToTodayCount: () => goToTodayCount,
  dirtyChanges: () => [...dirtyChanges],
  clearCalls: () => {
    saveCalls = []
    fullSaveCalls = []
    deleteCalls = []
    pendingNavigateCalls = []
    cancelNavigationCalls = []
    windowOpenCalls = []
    getContentCalls = []
    menuClickCount = 0
    dirtyChanges = []
  },
  windowOpenCalls: () => [...windowOpenCalls],
  EntryConflictError,
  setToken: (token: string | null) => {
    currentToken = token
    currentGetContentReject = undefined
    doRender()
  },
  setAutoSave: (autoSave: boolean) => {
    lastRenderAutoSave = autoSave
    doRender()
  },
  setPendingNavDate: (date: string | null) => {
    appSetPendingNavDate?.(date)
  },
  setDate: (date: string) => {
    lastRenderDate = date
    doRender()
  },
  setRefreshSignal: (n: number) => {
    currentRefreshSignal = n
    doRender()
  },
  setContentForDate: (date: string, content: string, version: string | null) => {
    contentByDate.set(date, { content, version })
  },
  blockGetContent: (date: string) => {
    getContentBlockedForDate = date
  },
  unblockGetContent: () => {
    getContentBlockedForDate = null
    const resolvers = getContentBlockResolvers
    getContentBlockResolvers = []
    resolvers.forEach(r => r())
  },
  blockSave: () => {
    saveBlocked = true
  },
  unblockSave: () => {
    saveBlocked = false
    const resolvers = saveBlockResolvers
    saveBlockResolvers = []
    resolvers.forEach(r => r())
  },
  setOnline: (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
    window.dispatchEvent(new Event(online ? 'online' : 'offline'))
  },
  expiredCalls: () => expiredCount,
}
