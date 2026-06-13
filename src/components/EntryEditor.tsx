import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EntryConflictError } from '../hooks/useDiary'
import { TokenExpiredError } from '../api/driveEntries'
import { getDraft, deleteDraft } from '../lib/diaryCache'
import type { DraftEntry } from '../lib/diaryCache'
import { MAX_ANNIVERSARY_BADGES, type Anniversary, type LoadedDiaryEntry } from '../types'
import { todayYmd, weekdayLabel, diaryDateLabel, diaryDateParts, anniversariesNearEntry } from '../utils/date'
import { HistoryModal } from './HistoryModal'
import { shareEntry } from '../utils/share'
import { useI18n } from '../i18n'
import { useSaveProgress } from '../hooks/useSaveProgress'
import { useEvent, useLatestRef } from '../hooks/useEvent'
import { useAutoSave } from '../hooks/useAutoSave'
import { useKeyboardInset } from '../hooks/useKeyboardInset'
import { useScrollEdges } from '../hooks/useScrollEdges'
import { useDismissOnOutside } from '../hooks/useDismissOnOutside'
import { useSwipeNav } from '../hooks/useSwipeNav'
import { useHolidays } from '../hooks/useHolidays'
import type { HolidayCountry } from '../utils/holidays'
import { haptics } from '../utils/haptics'
import { Clock3, CloudUpload, ExternalLink, MoreHorizontal, Share2, Trash2 } from 'lucide-react'

const dayNavWhileTap = { scale: 0.82 }
const dayNavTransition = { type: 'spring' as const, stiffness: 600, damping: 25 }

// Keep the textarea focused (and the mobile keyboard open) when tapping a
// toolbar button, so the keyboard doesn't collapse and shift the toolbar down.
function preventFocusSteal(e: ReactPointerEvent) {
  e.preventDefault()
}

interface Props {
  date: string
  getContent: (date: string, options?: { forceNetwork?: boolean }) => Promise<LoadedDiaryEntry | null>
  onSave: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  onDelete: (date: string) => Promise<void>
  onMenuClick: () => void
  onDirtyChange: (isDirty: boolean) => void
  autoSave: boolean
  onPrevDay: () => void
  onNextDay: () => void
  onSelectDate: (date: string) => void
  pendingNavDate: string | null
  onPendingNavigate: () => void
  onCancelNavigation: () => void
  reauthSaveResult: LoadedDiaryEntry | null
  isSignedIn: boolean
  isOnline: boolean
  onExpired: () => void
  onGoToToday?: () => void
  refreshSignal?: number
  knownDates?: Set<string>
  diaryListLoaded?: boolean
  holidayCountry?: HolidayCountry
  anniversaries?: Anniversary[]
}

function SaveIcon() {
  return <CloudUpload className="btn-icon" aria-hidden="true" size={15} strokeWidth={1.5} />
}

function CheckIcon() {
  return (
    <svg className="btn-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 18.5A4.5 4.5 0 0 1 5 10a5 5 0 0 1 9.9-1A3.5 3.5 0 0 1 19 12.5"/>
      <path d="m9 15 2 2 4-4"/>
    </svg>
  )
}

function DiscardIcon() {
  return (
    <svg className="btn-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>
    </svg>
  )
}


const entryVariants = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0 }),
}
const entryTransition = { duration: 0.24, ease: 'easeOut' as const }

const SAVED_STATUS_VISIBLE_MS = 1600
const SAVED_STATUS_EXIT_MS = 220


function SpinnerIcon() {
  return <span className="btn-saving-spinner" aria-hidden="true" />
}

function TodayIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  )
}


const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function EntryEditor({ date, getContent, onSave, onDelete, onMenuClick, onDirtyChange, autoSave, onPrevDay, onNextDay, onSelectDate, pendingNavDate, onPendingNavigate, onCancelNavigation, reauthSaveResult, isSignedIn, isOnline, onExpired, onGoToToday, refreshSignal = 0, knownDates, diaryListLoaded, holidayCountry = 'off', anniversaries = [] }: Props) {
  const { t, locale } = useI18n()
  const { progress: saveProgress, startSave, completeSave } = useSaveProgress()
  const savedStatus = t.entry.savedStatus
  const [text, setText] = useState('')
  const charCount = text.length
  const [savedText, setSavedText] = useState('')
  const [baseVersion, setBaseVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [discardedText, setDiscardedText] = useState<string | null>(null)
  const discardToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while auto-save is silently persisting before an auto-confirmed day switch;
  // suppresses the "unsaved — leave?" banner so it doesn't flash in auto-save mode.
  const [autoNavSaving, setAutoNavSaving] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollWrapRef = useRef<HTMLDivElement>(null)
  const deleteDialogRef = useRef<HTMLDialogElement>(null)
  const fileIdRef = useRef<string | null>(null)
  const [hasConflict, setHasConflict] = useState(false)
  const [conflictRemote, setConflictRemote] = useState<LoadedDiaryEntry | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Set when a save couldn't reach Drive because the device is offline; the
  // edits stay dirty and are retried automatically once connectivity returns.
  const [pendingOfflineSave, setPendingOfflineSave] = useState(false)
  const pendingOfflineSaveRef = useLatestRef(pendingOfflineSave)
  const tokenExpiredForDateRef = useRef<string | null>(null)
  const weekday = weekdayLabel(date, locale)
  const dateParts = diaryDateParts(date, locale, true)
  const isToday = date === todayYmd()
  const yearHolidays = useHolidays(holidayCountry, Number(date.slice(0, 4)))
  const isHoliday = !!yearHolidays[date]
  const isFuture = date > todayYmd()
  const activeAnniversaries = useMemo(
    () => (anniversaries ?? []).filter(a => a.showBadge !== false),
    [anniversaries],
  )
  const anniversaryBadges = useMemo(
    () => anniversariesNearEntry(date, activeAnniversaries).slice(0, MAX_ANNIVERSARY_BADGES),
    [date, activeAnniversaries],
  )
  const daysDiff = (() => {
    const today = todayYmd()
    const [ty, tm, td] = today.split('-').map(Number)
    const [ey, em, ed] = date.split('-').map(Number)
    const ms = new Date(ey, em - 1, ed).getTime() - new Date(ty, tm - 1, td).getTime()
    return Math.round(ms / 86400000)
  })()

  // Latest-value mirrors so debounce timers, listeners, and async save flows can
  // read current props/state without being torn down on every change.
  const onSaveRef = useLatestRef(onSave)
  const getContentRef = useLatestRef(getContent)
  const textRef = useLatestRef(text)
  const savedTextRef = useLatestRef(savedText)
  const baseVersionRef = useLatestRef(baseVersion)
  const savingRef = useLatestRef(saving)
  const hasConflictRef = useLatestRef(hasConflict)
  const loadingRef = useLatestRef(loading)
  const loadFailedRef = useLatestRef(loadFailed)
  const refreshingRef = useLatestRef(refreshing)

  // Write through to the ref so a synchronous read later in the same handler
  // (before React commits the state update) sees the new value.
  const setSavedTextValue = useCallback((value: string) => {
    savedTextRef.current = value
    setSavedText(value)
  }, [savedTextRef])

  const setBaseVersionValue = useCallback((value: string | null) => {
    baseVersionRef.current = value
    setBaseVersion(value)
  }, [baseVersionRef])

  const applyLoadedEntry = useCallback((entry: LoadedDiaryEntry | null) => {
    const driveText = entry?.entry.content ?? ''
    setText(driveText)
    setSavedTextValue(driveText)
    setBaseVersionValue(entry?.meta.version ?? null)

    fileIdRef.current = entry?.meta.id ?? null
  }, [setBaseVersionValue, setSavedTextValue])

  // Restore an offline draft as dirty text. Keeping the draft's own
  // baseVersion/baseContent means a save still goes through normal conflict
  // detection if the entry changed on another device since the draft was made.
  const applyDraft = useCallback((draft: DraftEntry, fileId: string | null) => {
    setText(draft.content)
    setSavedTextValue(draft.baseContent ?? '')
    setBaseVersionValue(draft.baseVersion)
    fileIdRef.current = fileId
    setPendingOfflineSave(true)
    setStatus(t.entry.draftRestored)
  }, [setBaseVersionValue, setSavedTextValue, t])

  const dateKnownAbsent = diaryListLoaded === true && knownDates !== undefined && !knownDates.has(date)
  const isNewEmptyEntry = dateKnownAbsent && text === '' && savedText === '' && baseVersion === null

  useEffect(() => {
    let cancelled = false
    // If we already know this date has no entry (list is loaded and date absent),
    // skip the skeleton — show the empty editor immediately.
    setLoading(!dateKnownAbsent)
    setRefreshing(false)
    setText('')
    setSavedTextValue('')
    setBaseVersionValue(null)

    setStatus('')
    setLoadFailed(false)
    setHasConflict(false)
    setConflictRemote(null)
    setPendingOfflineSave(false)
    setDiscardedText(null)
    if (discardToastTimerRef.current) { clearTimeout(discardToastTimerRef.current); discardToastTimerRef.current = null }
    fileIdRef.current = null
    void (async () => {
      let entry: LoadedDiaryEntry | null = null
      let loadError: unknown = null
      try {
        entry = await getContentRef.current(date)
      } catch (e) {
        loadError = e
      }
      if (cancelled) return
      if (loadError instanceof TokenExpiredError) {
        tokenExpiredForDateRef.current = date
        setLoading(false)
        return
      }
      const draft = await getDraft(date).catch(() => undefined)
      if (cancelled) return
      if (loadError === null) {
        if (draft && draft.content !== (entry?.entry.content ?? '')) {
          applyDraft(draft, entry?.meta.id ?? null)
        } else {
          // No draft, or the draft already made it to Drive — drop it.
          if (draft) deleteDraft(date).catch(() => {})
          applyLoadedEntry(entry)
        }
      } else if (draft) {
        // Couldn't reach Drive but an offline draft exists — let the user keep
        // editing it; it syncs once connectivity returns.
        applyDraft(draft, null)
      } else if (dateKnownAbsent && typeof navigator !== 'undefined' && !navigator.onLine) {
        // Offline on a date known to have no entry: writing is safe, the text
        // is preserved as a draft on the first save attempt.
        applyLoadedEntry(null)
      } else {
        setLoadFailed(true)
        setStatus(t.entry.failedToLoad)
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [date, applyLoadedEntry, applyDraft, dateKnownAbsent])

  const directionRef = useRef(0)
  const prevDateRef = useRef(date)
  if (date !== prevDateRef.current) {
    directionRef.current = date > prevDateRef.current ? 1 : -1
    prevDateRef.current = date
  }
  const currentDateRef = useRef(date)
  currentDateRef.current = date

  const isDirty = text !== savedText

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => {
    if (!reauthSaveResult || reauthSaveResult.entry.date !== date) return

    const content = reauthSaveResult.entry.content
    const currentText = textRef.current
    const previousSavedText = savedTextRef.current

    setSavedTextValue(content)
    setBaseVersionValue(reauthSaveResult.meta.version ?? null)

    fileIdRef.current = reauthSaveResult.meta.id

    if (currentText === previousSavedText || currentText === content) {
      setText(content)
      setStatus(savedStatus)
    }
  }, [date, reauthSaveResult, savedStatus, setBaseVersionValue, setSavedTextValue])

  const pendingNavDateRef = useLatestRef(pendingNavDate)
  const onCancelNavigationRef = useLatestRef(onCancelNavigation)

  const save = useCallback(async (explicit = true): Promise<boolean> => {
    if (savingRef.current) return false
    if (loadFailedRef.current) return false
    setSaving(true)
    if (explicit) startSave()
    if (explicit) {
      setStatus('')
      setHasConflict(false)
      setConflictRemote(null)
    }
    let success = false
    try {
      const currentText = textRef.current
      const saved = await onSaveRef.current(date, currentText, baseVersionRef.current, undefined, savedTextRef.current)
      const newVersion = saved.meta.version ?? null
      const newId = saved.meta.id
      setSavedTextValue(currentText)
      setBaseVersionValue(newVersion)
      fileIdRef.current = newId
      setPendingOfflineSave(false)
      setStatus(savedStatus)
      success = true
      if (explicit) haptics.success()
      return true
    } catch (e) {
      // Offline: the fetch never reached Drive. Keep the edits dirty and let the
      // reconnect effect retry rather than reporting a hard failure.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setPendingOfflineSave(true)
        setStatus(t.entry.offlineSavePending)
        return false
      }
      if (!explicit) {
        console.error('Auto-save failed:', e)
        return false
      }
      if (e instanceof EntryConflictError) {
        setHasConflict(true)
        setConflictRemote(e.remote)
        setStatus(t.entry.changedElsewhere)
        haptics.warning()
      } else {
        setStatus(t.entry.saveFailed)
        haptics.error()
      }
      return false
    } finally {
      setSaving(false)
      if (explicit) completeSave(success)
    }
  }, [date, savedStatus, t, setBaseVersionValue, setSavedTextValue, startSave, completeSave])

  const handleExplicitSave = useCallback(async () => {
    const ok = await save(true)
    if (ok && pendingNavDateRef.current) {
      onCancelNavigationRef.current()
    }
  }, [save])

  const handleSaveAndNavigate = useCallback(async () => {
    const ok = await save(true)
    if (ok) {
      onPendingNavigate()
    } else {
      onCancelNavigation()
    }
  }, [save, onPendingNavigate, onCancelNavigation])

  // In auto-save mode a pending day switch shouldn't surface the "save before
  // leaving?" banner — just persist the edits and navigate. If the save fails
  // (offline / conflict), fall back to showing the banner for manual resolution.
  useEffect(() => {
    if (!pendingNavDate || !autoSave) { setAutoNavSaving(false); return }
    let active = true
    setAutoNavSaving(true)
    void (async () => {
      // Nothing unsaved (e.g. already flushed) — just navigate.
      const ok = textRef.current === savedTextRef.current ? true : await save(false)
      if (!active) return
      setAutoNavSaving(false)
      if (ok) onPendingNavigate()
    })()
    return () => { active = false }
  }, [pendingNavDate, autoSave, save, onPendingNavigate])

  const loadRemote = () => {
    const remoteText = conflictRemote?.entry.content ?? ''
    setText(remoteText)
    setSavedTextValue(remoteText)
    setBaseVersionValue(conflictRemote?.meta.version ?? null)
    setHasConflict(false)
    setConflictRemote(null)
    setPendingOfflineSave(false)
    deleteDraft(date).catch(() => {})
    setStatus(conflictRemote ? t.entry.loadedLatest : t.entry.remoteDeleted)
  }

  const keepLocal = () => {
    setHasConflict(false)
    setConflictRemote(null)
    setStatus(t.entry.localKept)
  }

  const overwriteRemote = async () => {
    setSaving(true)
    setStatus('')
    try {
      const currentText = textRef.current
      const saved = await onSaveRef.current(date, currentText, conflictRemote?.meta.version ?? baseVersionRef.current, true)
      setSavedTextValue(currentText)
      setBaseVersionValue(saved.meta.version ?? null)
      setHasConflict(false)
      setConflictRemote(null)
      setPendingOfflineSave(false)
      setStatus(savedStatus)
    } catch {
      setStatus(t.entry.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const loadFreshEntry = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const capturedDate = date
    if (!silent) setRefreshing(true)
    setStatus('')
    try {
      const entry = await getContentRef.current(date, { forceNetwork: !silent })
      if (currentDateRef.current !== capturedDate) return
      if (silent && textRef.current !== savedTextRef.current) return
      applyLoadedEntry(entry)
      setLoadFailed(false)
      setHasConflict(false)
      setConflictRemote(null)
    } catch {
      if (currentDateRef.current === capturedDate && !silent) setStatus(t.entry.failedToRefresh)
    } finally {
      if (currentDateRef.current === capturedDate && !silent) setRefreshing(false)
    }
  }, [date, applyLoadedEntry])

  useEffect(() => {
    if (refreshSignal <= 0) return
    if (loadingRef.current || savingRef.current || refreshingRef.current || hasConflictRef.current) return
    if (textRef.current !== savedTextRef.current) return
    void loadFreshEntry({ silent: true })
  }, [refreshSignal, loadFreshEntry])

  useEffect(() => {
    if (isSignedIn && tokenExpiredForDateRef.current === date) {
      tokenExpiredForDateRef.current = null
      let cancelled = false
      setLoading(true)
      setStatus('')
      setLoadFailed(false)
      getContentRef.current(date).then(entry => {
        if (cancelled) return
        applyLoadedEntry(entry)
      }).catch(() => {
        if (!cancelled) setStatus(t.entry.failedToRefresh)
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
      return () => { cancelled = true }
    }
  }, [isSignedIn, date, applyLoadedEntry])

  const handleDiscardClick = () => {
    const previous = text
    setText(savedTextRef.current)
    setStatus('')
    deleteDraft(date).catch(() => {})
    if (pendingOfflineSaveRef.current) {
      setPendingOfflineSave(false)
      // A restored draft's base may lag the latest cached entry — reload it.
      const capturedDate = date
      getContentRef.current(date)
        .then(entry => { if (currentDateRef.current === capturedDate) applyLoadedEntry(entry) })
        .catch(() => {})
    }
    setDiscardedText(previous)
    if (discardToastTimerRef.current) clearTimeout(discardToastTimerRef.current)
    discardToastTimerRef.current = setTimeout(() => setDiscardedText(null), 5000)
  }

  const handleUndoDiscard = () => {
    if (discardedText !== null) {
      setText(discardedText)
      setDiscardedText(null)
      if (discardToastTimerRef.current) clearTimeout(discardToastTimerRef.current)
    }
  }

  const del = async () => {
    setDeleteInput('')
    setShowDeleteModal(true)
  }

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await onDelete(date)
      setShowDeleteModal(false)
      applyLoadedEntry(null)
      setStatus('')
      haptics.delete()
    } catch {
      setStatus(t.entry.deleteFailed)
      setShowDeleteModal(false)
    } finally {
      setDeleting(false)
    }
  }

  // A silent save may run when nothing is in flight and there are unsaved edits.
  const canAutoSave = useEvent(() =>
    !savingRef.current && !hasConflictRef.current && !loadingRef.current && !loadFailedRef.current &&
    textRef.current !== savedTextRef.current,
  )
  const flushPendingAutoSave = useAutoSave({ enabled: autoSave, isDirty, text, save, canSave: canAutoSave })

  // When connectivity returns, retry a save that failed while offline.
  useEffect(() => {
    if (!isOnline || !pendingOfflineSaveRef.current) return
    if (textRef.current === savedTextRef.current) { setPendingOfflineSave(false); return }
    if (savingRef.current || hasConflictRef.current || loadingRef.current || loadFailedRef.current) return
    void save(!autoSave)
  }, [autoSave, isOnline, save])

  // Ctrl+S / Cmd+S explicit save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!autoSave && isDirty) handleExplicitSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [autoSave, isDirty, handleExplicitSave])

  useEffect(() => {
    if (status !== savedStatus) return

    const clearTimeout = window.setTimeout(() => {
      setStatus(current => current === savedStatus ? '' : current)
    }, SAVED_STATUS_VISIBLE_MS + SAVED_STATUS_EXIT_MS)

    return () => {
      window.clearTimeout(clearTimeout)
    }
  }, [status, savedStatus])

  useEffect(() => () => {
    if (discardToastTimerRef.current) clearTimeout(discardToastTimerRef.current)
  }, [])

  useKeyboardInset()

  const closeMoreMenu = useCallback(() => setShowMoreMenu(false), [])
  useDismissOnOutside(moreMenuRef, showMoreMenu, closeMoreMenu)

  const [shareMsgVisible, setShareMsgVisible] = useState(false)
  const { scrollAtTop, scrollAtBottom, attachScrollListeners } = useScrollEdges(textareaRef, { loading, text })
  const [dateTransitionMask, setDateTransitionMask] = useState(false)
  const [dateTransitionMaskSide, setDateTransitionMaskSide] = useState<'left' | 'right'>('right')

  const dateTransitionMaskDateRef = useRef(date)

  useEffect(() => {
    if (dateTransitionMaskDateRef.current === date) return
    dateTransitionMaskDateRef.current = date
    setDateTransitionMaskSide(directionRef.current < 0 ? 'left' : 'right')
    setDateTransitionMask(true)
  }, [date])

  // Horizontal swipe on the entry body navigates between days; goes through the
  // same onPrevDay/onNextDay path as the buttons, so the unsaved-changes guard
  // and the directional slide animation apply unchanged.
  useSwipeNav(scrollWrapRef, { onSwipeLeft: onNextDay, onSwipeRight: onPrevDay })

  async function handleShareEntry() {
    setShowMoreMenu(false)
    const label = diaryDateLabel(date, true, 'long', locale)
    try {
      const result = await shareEntry(date, text, label)
      if (result === 'copied') {
        setShareMsgVisible(true)
        setTimeout(() => setShareMsgVisible(false), 2000)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e)
    }
  }


  return (
    <>
    <AnimatePresence>
      {showHistoryModal && fileIdRef.current && isSignedIn && (
        <HistoryModal
        date={date}
        fileId={fileIdRef.current}
        baseVersion={baseVersion}
        text={text}
        savedText={savedText}
        isDirty={isDirty}
        autoSave={autoSave}
        onSave={onSave}
        onRestored={(result) => {
          const content = result.entry.content
          setText(content)
          setSavedTextValue(content)
          setBaseVersionValue(result.meta.version ?? null)
          fileIdRef.current = result.meta.id
          setShowHistoryModal(false)
        }}
        onClose={() => setShowHistoryModal(false)}
        onExpired={onExpired}
      />
      )}
    </AnimatePresence>
    <AnimatePresence>
      {showDeleteModal && (
        <motion.dialog
          ref={(node) => {
            if (node) {
              deleteDialogRef.current = node
              if (!node.open) node.showModal()
            } else {
              if (deleteDialogRef.current?.open) deleteDialogRef.current.close()
              deleteDialogRef.current = null
            }
          }}
          className="delete-dialog"
          aria-labelledby="delete-dialog-title"
          onCancel={(e) => { e.preventDefault(); setShowDeleteModal(false) }}
          onClick={(e) => { if (e.target === deleteDialogRef.current) setShowDeleteModal(false) }}
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        >
          <h3 id="delete-dialog-title">{t.entry.deleteTitle}</h3>
          <p>{t.entry.deleteDescription(diaryDateLabel(date, true, 'long', locale))}</p>
          <p className="delete-modal-hint">{t.entry.deleteHint}</p>
          <input
            className="delete-modal-input"
            value={deleteInput}
            onChange={e => setDeleteInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && deleteInput === t.entry.confirmKeyword) confirmDelete() }}
            autoFocus
            placeholder={t.entry.confirmKeyword}
            aria-label={t.entry.confirmKeyword}
          />
          <div className="delete-modal-actions">
            <button onClick={() => setShowDeleteModal(false)} disabled={deleting}>{t.common.cancel}</button>
            <button
              className={`btn-delete${deleting ? ' btn-saving' : ''}`}
              onClick={confirmDelete}
              disabled={deleteInput !== t.entry.confirmKeyword || deleting}
              aria-busy={deleting}
            >{deleting ? <><SpinnerIcon />{t.common.deletingEllipsis}</> : t.common.delete}</button>
          </div>
        </motion.dialog>
      )}
    </AnimatePresence>
    <div className="editor">
      {saveProgress !== null && (
        <div className="save-progress-bar" aria-hidden="true">
          <div
            className="save-progress-bar-fill"
            style={{
              width: `${saveProgress * 100}%`,
              opacity: saveProgress >= 1 ? 0 : 1,
              transition: saveProgress >= 1
                ? 'width 0.15s ease-out, opacity 0.45s ease 0.1s'
                : 'width 60ms linear',
            }}
          />
        </div>
      )}
      <div className="editor-header">
        <div className="editor-date-group">
          <button className="btn-menu" onPointerDown={preventFocusSteal} onClick={onMenuClick} title={t.entry.openMenu} aria-label={t.entry.openMenu}>☰</button>
          <motion.button className="btn-day-nav" onPointerDown={preventFocusSteal} onClick={onPrevDay} aria-label={t.entry.previousDay}
            whileTap={dayNavWhileTap} transition={dayNavTransition}
          >‹</motion.button>
          <h2>
            <span
              className="entry-date-text"
              data-today={isToday || undefined}
              aria-label={isToday ? `${diaryDateLabel(date, true, 'long', locale, true)}${weekday ? ` ${weekday}` : ''}, ${t.common.today}` : undefined}
            >
              {dateParts.yearFirst && dateParts.year && <span className="entry-date-year">{dateParts.year}</span>}
              <span className="entry-date-monthday">
                {dateParts.monthDay}
                {weekday && !(!dateParts.yearFirst && dateParts.year) && <span className={`entry-date-weekday${isHoliday ? ' holiday' : ''}`}>{weekday}</span>}
              </span>
              {!dateParts.yearFirst && dateParts.year && (
                <span className="entry-date-year">
                  {dateParts.year}
                  {weekday && <span className={`entry-date-weekday${isHoliday ? ' holiday' : ''}`}>{weekday}</span>}
                </span>
              )}
            </span>
          </h2>
          <motion.button className="btn-day-nav" onPointerDown={preventFocusSteal} onClick={onNextDay} aria-label={t.entry.nextDay}
            whileTap={dayNavWhileTap} transition={dayNavTransition}
          >›</motion.button>
        </div>
        <div className="editor-actions">
          <AnimatePresence>
            {isDirty && !loading && !saving && !autoSave && (
              <motion.button
                className="btn-discard"
                onPointerDown={preventFocusSteal}
                onClick={handleDiscardClick}
                aria-label={t.common.discard}
                initial={{ opacity: 0, width: 0, marginRight: '-0.7rem' }}
                animate={{ opacity: 1, width: 'auto', marginRight: 0 }}
                exit={{ opacity: 0, width: 0, marginRight: '-0.7rem' }}
                transition={{ duration: 0.18, ease: 'easeInOut' }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
                whileTap={{ scale: 0.95 }}
              >
                <DiscardIcon />
                <span className="btn-text">{t.common.discard}</span>
              </motion.button>
            )}
          </AnimatePresence>
          <motion.button
            className={`btn-save${saving ? ' btn-saving' : status === savedStatus ? ' btn-saved' : ''}`}
            onPointerDown={preventFocusSteal}
            onClick={handleExplicitSave}
            disabled={autoSave || saving || !isDirty || loadFailed}
            aria-busy={saving}
            aria-label={saving ? t.entry.saving : status === savedStatus ? t.common.saved : autoSave ? t.entry.autoSave : t.entry.save}
            title={autoSave ? undefined : isMac ? '⌘S' : 'Ctrl+S'}
            data-autosave={autoSave || undefined}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
              {saving ? <SpinnerIcon /> : status === savedStatus ? <CheckIcon /> : <SaveIcon />}
              <span className="btn-text">{saving ? t.common.savingEllipsis : status === savedStatus ? t.common.saved : autoSave ? t.entry.autoSave : t.entry.save}</span>
            </span>
          </motion.button>
          {!isToday && onGoToToday && (
            <button
              type="button"
              className="btn-today-fab"
              onPointerDown={preventFocusSteal}
              onClick={onGoToToday}
              aria-label={t.common.today}
              title={t.common.today}
            >
              <TodayIcon />
              {t.common.today}
            </button>
          )}
          <div className="more-menu-container" ref={moreMenuRef}>
            <motion.button className="btn-more" onPointerDown={preventFocusSteal} onClick={() => setShowMoreMenu(v => !v)} aria-label={t.entry.moreOptions}
              aria-expanded={showMoreMenu}
              aria-controls={showMoreMenu ? 'entry-more-menu' : undefined}
              whileTap={{ scale: 0.88 }}
              transition={{ type: 'spring', stiffness: 600, damping: 25 }}
            >
              <MoreHorizontal className="btn-icon" aria-hidden="true" size={18} strokeWidth={2.2} />
            </motion.button>
            <AnimatePresence>
              {showMoreMenu && (
                <motion.div id="entry-more-menu" className="more-menu"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                >
                  {isDirty && !loading && !saving && !autoSave && (
                    <button type="button" className="more-menu-item more-menu-discard" onClick={() => { setShowMoreMenu(false); handleDiscardClick() }}>
                      <DiscardIcon />
                      {t.common.discard}
                    </button>
                  )}
                  {isSignedIn && fileIdRef.current && (
                    <button type="button" className="more-menu-item" onClick={() => { setShowMoreMenu(false); setShowHistoryModal(true) }}>
                      <Clock3 className="btn-icon" aria-hidden="true" size={15} strokeWidth={2} />
                      {t.entry.history}
                    </button>
                  )}
                  {isSignedIn && fileIdRef.current && (
                    <button type="button" className="more-menu-item" onClick={() => {
                      setShowMoreMenu(false)
                      window.open(`https://drive.google.com/file/d/${fileIdRef.current}/view`, '_blank')
                    }}>
                      <ExternalLink className="btn-icon" aria-hidden="true" size={15} strokeWidth={2} />
                      {t.entry.openInDrive}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`more-menu-item${!fileIdRef.current ? ' more-menu-item-disabled' : ''}`}
                    onClick={fileIdRef.current ? handleShareEntry : undefined}
                    disabled={!fileIdRef.current}
                  >
                    <Share2 className="btn-icon" aria-hidden="true" size={15} strokeWidth={2} />
                    {t.entry.shareEntry}
                  </button>
                  <button
                    type="button"
                    className={`more-menu-item more-menu-delete${!fileIdRef.current ? ' more-menu-item-disabled' : ''}`}
                    onClick={fileIdRef.current ? del : undefined}
                    disabled={!fileIdRef.current}
                  >
                    <Trash2 className="btn-icon" aria-hidden="true" size={15} strokeWidth={2} />
                    {t.common.delete}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <div className={`editor-meta${loading && !isToday ? ' editor-meta--loading' : ''}${isFuture ? ' editor-meta--future' : ''}`}>
        {isToday && <span className="editor-meta-today">{t.common.today}</span>}
        {!isToday && (
          <span className="editor-meta-time">
            {!isFuture && t.entry.daysAgo(Math.abs(daysDiff))}
            {isFuture && t.entry.daysAhead(daysDiff)}
          </span>
        )}
        {anniversaryBadges.map(({ id, label, date: anniversaryDate, distance }) => (
          <button
            key={id}
            type="button"
            className={`editor-meta-anniversary${distance === 0 ? ' editor-meta-anniversary--on' : ''}`}
            onClick={() => onSelectDate(anniversaryDate)}
            aria-label={t.entry.anniversaryOpen(label, anniversaryDate)}
          >
            {distance === 0 ? t.entry.anniversaryOn(label)
             : distance > 0 ? t.entry.anniversaryBefore(label, distance)
             : t.entry.anniversaryAfter(label, Math.abs(distance))}
          </button>
        ))}
        <AnimatePresence initial={false}>
          {!isOnline && (
            <motion.span
              key="offline"
              className="editor-meta-offline"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <span className="editor-meta-offline-dot" aria-hidden="true" />
              {t.entry.offlineBadge}
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {isDirty && !loading && (
            <motion.span
              key="unsaved"
              className="editor-meta-unsaved"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >{t.common.unsaved}</motion.span>
          )}
        </AnimatePresence>
      </div>
      {shareMsgVisible && (
        <div className="editor-share-toast" role="status">{t.entry.copiedToClipboard}</div>
      )}
      <AnimatePresence>
        {status && status !== savedStatus && !loadFailed && (
          <motion.div
            className="editor-status-line"
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {status}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {discardedText !== null && (
          <motion.div
            className="discard-undo-toast"
            role="status"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <span>{t.entry.discardedUndo}</span>
            <button onClick={handleUndoDiscard}>{t.common.undo}</button>
          </motion.div>
        )}
      </AnimatePresence>
      {pendingNavDate && !autoNavSaving && (
        <div className="unsaved-nav-banner">
          <span>{t.entry.unsavedLeave}</span>
          <div className="unsaved-nav-actions">
            <button onClick={handleSaveAndNavigate} disabled={saving}>{t.common.save}</button>
            <button onClick={onPendingNavigate}>{t.common.discard}</button>
            <button onClick={onCancelNavigation}>{t.common.cancel}</button>
          </div>
        </div>
      )}
      {hasConflict && (
        <div className="conflict-panel">
          <div>
            <strong>{t.entry.conflictTitle}</strong>
            <p>{conflictRemote ? t.entry.conflictRemote : t.entry.conflictDeleted}</p>
          </div>
          <div className="conflict-actions">
            <button onClick={loadRemote}>{conflictRemote ? t.entry.loadLatest : t.entry.clearLocal}</button>
            <button onClick={keepLocal}>{t.entry.keepLocal}</button>
            <button className="btn-delete" onClick={overwriteRemote} disabled={saving}>{t.entry.overwrite}</button>
          </div>
        </div>
      )}
      <div ref={scrollWrapRef} className={`editor-scroll-wrap${scrollAtTop ? ' scroll-at-top' : ''}${scrollAtBottom ? ' scroll-at-bottom' : ''}${dateTransitionMask ? ` date-transition-mask date-transition-mask-${dateTransitionMaskSide}` : ''}`}>
      <AnimatePresence initial={false} custom={directionRef.current}>
        <motion.div
          key={date}
          custom={directionRef.current}
          variants={entryVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={entryTransition}
          onAnimationComplete={(definition) => {
            if (definition === 'center') setDateTransitionMask(false)
          }}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {loading ? (
              <motion.div
                key="skeleton"
                className="entry-skeleton"
                aria-label={t.entry.loadingEntry}
                aria-live="polite"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeInOut' }}
              >
                <div className="entry-skeleton-row short" />
                <div className="entry-skeleton-row" />
                <div className="entry-skeleton-row medium" />
                <div className="entry-skeleton-row" />
                <div className="entry-skeleton-row long" />
                <div className="entry-skeleton-row medium" />
              </motion.div>
            ) : loadFailed ? (
              <motion.div
                key="load-error"
                className="entry-load-error"
                role="alert"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeInOut' }}
              >
                <strong>{t.entry.failedToLoad}</strong>
                <p>{t.entry.failedToLoadHint}</p>
                <button onClick={() => loadFreshEntry()} disabled={refreshing}>
                  {refreshing ? t.entry.refreshingEntry : t.entry.refreshEntry}
                </button>
              </motion.div>
            ) : (
              <motion.textarea
                key="textarea"
                ref={textareaRef}
                className="editor-textarea"
                value={text}
                onChange={e => {
                  if (loadFailed) return
                  textRef.current = e.target.value
                  setText(e.target.value)
                  if (status && status !== savedStatus) setStatus('')
                }}
                onBlur={flushPendingAutoSave}
                readOnly={loadFailed}
                placeholder={isNewEmptyEntry ? t.entry.newPlaceholder : t.entry.placeholder}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                onAnimationComplete={attachScrollListeners}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </AnimatePresence>
      </div>
      {!loading && !loadFailed && !isNewEmptyEntry && (
        <div className="editor-charcount" aria-hidden="true">
          {t.entry.charCount(charCount)}
        </div>
      )}
    </div>
    </>
  )
}
