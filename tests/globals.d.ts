/// <reference types="vite/client" />

interface Window {
  __historyXss?: boolean
  calendarHarness: {
    selectedDates: () => string[]
  }
  themeHarness: {
    mode: () => 'light' | 'dark' | 'system'
    effectiveTheme: () => 'light' | 'dark'
    toggle: () => void
  }
  fontHarness: {
    mode: () => 'serif' | 'sans'
    toggle: () => void
  }
  settingsHarness: {
    render: (opts?: { autoSave?: boolean; modalOpen?: boolean; themeMode?: 'light' | 'dark' | 'system'; fontSize?: import('../src/hooks/useFontSize').FontSize; email?: string }) => void
    getStoredAutoSave: () => string | null
    getStoredTheme: () => string | null
    exportCalls: () => { hasProgress: boolean }[]
    setExportReject: (v: boolean) => void
  }
  searchHarness: {
    render: (opts?: {
      entriesLoading?: boolean
    }) => void
    setSearchResult: (query: string, result: import('../src/hooks/useDiary').SearchResult) => void
    calls: () => string[]
    selectedDates: () => string[]
  }
  diaryHarness: {
    q: (...responses: { status: number; body: unknown; delayMs?: number }[]) => void
    calls: () => { url: string; method: string; body?: string }[]
    clearCalls: () => void
    start: () => void
    save: (
      date: string,
      content: string,
      baseVersion: string | null,
      force?: boolean,
      baseContent?: string | null,
    ) => Promise<
      | { ok: true; result: import('../src/types').LoadedDiaryEntry }
      | { ok: false; conflict: unknown; error: string }
    >
    triggerGetContent: (date: string, options?: { forceNetwork?: boolean }) => Promise<import('../src/types').LoadedDiaryEntry | null>
    search: (query: string) => Promise<import('../src/hooks/useDiary').SearchResult>
    exportAll: () => Promise<{ date: string; content: string }[]>
    refreshEntries: () => Promise<void>
    retryPendingSave: () => Promise<
      | { ok: true; result: import('../src/types').LoadedDiaryEntry | null }
      | { ok: false; conflict: unknown; error: string }
    >
    progressCalls: () => { done: number; total: number }[]
    resetFolderState: () => void
    expiredCalls: () => number
    clearExpiredCalls: () => void
    evictedCalls: () => string[][]
    clearEvictedCalls: () => void
    setEmail: (e: string | null) => void
    setSelectedDate: (date: string | undefined) => void
    seedLocalStorageUser: (u: string | null) => void
    seedIdb: (entries: { date: string; meta: unknown; content?: unknown; snippet?: string }[]) => Promise<void>
  }
  editorHarness: {
    render: (opts: {
      date?: string
      initialContent?: string
      version?: string | null
      saveReject?: 'conflict' | 'error'
      getContentReject?: 'tokenExpired' | 'error'
      deleteReject?: 'error'
      autoSave?: boolean
      getContentDelayMs?: number
      pendingNavDate?: string | null
      token?: string | null
      saveDelayMs?: number
    }) => void
    saveCalls: () => { date: string; content: string; baseVersion: string | null; force?: boolean }[]
    saveCallsWithBaseContent: () => {
      date: string
      content: string
      baseVersion: string | null
      force?: boolean
      baseContent?: string | null
    }[]
    getContentCalls: () => { date: string }[]
    setRemoteEntry: (content: string, version: string | null) => void
    deleteCalls: () => { date: string }[]
    pendingNavigateCalls: () => { date: string | null }[]
    cancelNavigationCalls: () => { date: string | null }[]
    menuClickCount: () => number
    dirtyChanges: () => boolean[]
    clearCalls: () => void
    windowOpenCalls: () => { url: string; target: string }[]
    EntryConflictError: typeof import('../src/hooks/useDiary').EntryConflictError
    setToken: (token: string | null) => void
    expiredCalls: () => number
    setDate: (date: string) => void
    setRefreshSignal: (n: number) => void
    setContentForDate: (date: string, content: string, version: string | null) => void
    blockGetContent: (date: string) => void
    unblockGetContent: () => void
    setOnline: (online: boolean) => void
  }
  historyHarness: {
    list: (resp: { status: number; body: unknown; delayMs?: number }) => void
    content: (responses: Record<string, { status: number; body: unknown; delayMs?: number }>) => void
    reset: () => void
    render: (opts?: { date?: string; fileId?: string; baseVersion?: string | null; text?: string; savedText?: string; isDirty?: boolean; autoSave?: boolean }) => void
    calls: () => { url: string; method: string }[]
    saveCalls: () => { date: string; content: string; baseVersion: string | null; force?: boolean }[]
    saveCallsWithBaseContent: () => {
      date: string
      content: string
      baseVersion: string | null
      force?: boolean
      baseContent?: string | null
    }[]
    restoredCalls: () => import('../src/types').LoadedDiaryEntry[]
    closeCalls: () => number
    expiredCalls: () => number
    setSaveReject: (v: 'conflict' | 'error' | null) => void
  }
  loginScreenHarness: {
    render: (opts?: {
      tokenExpired?: boolean
    }) => void
  }
  recollectionHarness: {
    render: (opts: { dates: string[]; contents?: Record<string, string>; serendipityPrefetch?: string[] }) => void
    selectedDates: () => string[]
    closeCount: () => number
  }
}
