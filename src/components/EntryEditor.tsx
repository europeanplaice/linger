import { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EntryConflictError } from '../hooks/useDiary'
import { TokenExpiredError } from '../api/driveEntries'
import type { LoadedDiaryEntry } from '../types'
import { todayYmd, yesterdayYmd, weekdayLabel, diaryDateLabel } from '../utils/date'
import { HistoryModal } from './HistoryModal'
import { shareEntry } from '../utils/share'
import { useI18n } from '../i18n'
import { useSaveProgress } from '../hooks/useSaveProgress'

const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const dayNavWhileTap = coarsePointer
  ? { scale: 0.82, backgroundColor: 'var(--border)', color: 'var(--text)' }
  : { scale: 0.82 }
const dayNavTransition = coarsePointer
  ? { type: 'spring' as const, stiffness: 600, damping: 25, backgroundColor: { duration: 0 }, color: { duration: 0 } }
  : { type: 'spring' as const, stiffness: 600, damping: 25 }

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
  pendingNavDate: string | null
  onPendingNavigate: () => void
  onCancelNavigation: () => void
  reauthSaveResult: LoadedDiaryEntry | null
  isSignedIn: boolean
  onExpired: () => void
  refreshSignal?: number
}

function SaveIcon() {
  return (
    <svg className="btn-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="btn-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
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

const SAVED_STATUS_VISIBLE_MS = 1600
const SAVED_STATUS_EXIT_MS = 220
const AUTO_SAVE_MS = 1500
const KEYBOARD_INSET_VAR = '--mobile-keyboard-inset-bottom'


function SpinnerIcon() {
  return <span className="btn-saving-spinner" aria-hidden="true" />
}


export function EntryEditor({ date, getContent, onSave, onDelete, onMenuClick, onDirtyChange, autoSave, onPrevDay, onNextDay, pendingNavDate, onPendingNavigate, onCancelNavigation, reauthSaveResult, isSignedIn, onExpired, refreshSignal = 0 }: Props) {
  const { t, locale } = useI18n()
  const { progress: saveProgress, startSave, completeSave } = useSaveProgress()
  const savedStatus = t.entry.savedStatus
  const [text, setText] = useState('')
  const charCount = text.length
  const [savedText, setSavedText] = useState('')
  const [baseVersion, setBaseVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [showDiscardModal, setShowDiscardModal] = useState(false)
  const discardDialogRef = useRef<HTMLDialogElement>(null)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [lastModified, setLastModified] = useState<string | null>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const deleteDialogRef = useRef<HTMLDialogElement>(null)
  const fileIdRef = useRef<string | null>(null)
  const [hasConflict, setHasConflict] = useState(false)
  const [conflictRemote, setConflictRemote] = useState<LoadedDiaryEntry | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const tokenExpiredForDateRef = useRef<string | null>(null)
  const weekday = weekdayLabel(date, locale)
  const isToday = date === todayYmd()
  const isYesterday = date === yesterdayYmd()
  const isFuture = date > todayYmd()

  // Use a ref to track the latest onSave without restarting debounce timers
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])
  const getContentRef = useRef(getContent)
  useEffect(() => { getContentRef.current = getContent }, [getContent])
const textRef = useRef(text)
const savedTextRef = useRef(savedText)
const baseVersionRef = useRef(baseVersion)
const savingRef = useRef(saving)
const hasConflictRef = useRef(hasConflict)
const loadingRef = useRef(loading)
const loadFailedRef = useRef(loadFailed)
const refreshingRef = useRef(refreshing)

const setSavedTextValue = useCallback((value: string) => {
  savedTextRef.current = value
  setSavedText(value)
}, [])

const setBaseVersionValue = useCallback((value: string | null) => {
  baseVersionRef.current = value
  setBaseVersion(value)
}, [])

useEffect(() => {
  textRef.current = text
  savedTextRef.current = savedText
  baseVersionRef.current = baseVersion
  savingRef.current = saving
  hasConflictRef.current = hasConflict
  loadingRef.current = loading
  loadFailedRef.current = loadFailed
  refreshingRef.current = refreshing
}, [text, savedText, baseVersion, saving, hasConflict, loading, loadFailed])

  const applyLoadedEntry = useCallback((entry: LoadedDiaryEntry | null) => {
    const driveText = entry?.entry.content ?? ''
    setText(driveText)
    setSavedTextValue(driveText)
    setBaseVersionValue(entry?.meta.version ?? null)
    setLastModified(entry?.entry.updated_at ?? null)
    fileIdRef.current = entry?.meta.id ?? null
  }, [setBaseVersionValue, setSavedTextValue])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRefreshing(false)
    setText('')
    setSavedTextValue('')
    setBaseVersionValue(null)
    setLastModified(null)
    setStatus('')
    setLoadFailed(false)
    setHasConflict(false)
    setConflictRemote(null)
    fileIdRef.current = null
    getContentRef.current(date).then(entry => {
      if (cancelled) return
      applyLoadedEntry(entry)
    }).catch((e) => {
      if (!cancelled) {
        if (e instanceof TokenExpiredError) {
          tokenExpiredForDateRef.current = date
          return
        }
        setLoadFailed(true)
        setStatus(t.entry.failedToLoad)
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [date, applyLoadedEntry])

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
    setLastModified(reauthSaveResult.entry.updated_at ?? null)
    fileIdRef.current = reauthSaveResult.meta.id

    if (currentText === previousSavedText || currentText === content) {
      setText(content)
      setStatus(savedStatus)
    }
  }, [date, reauthSaveResult, savedStatus, setBaseVersionValue, setSavedTextValue])

  const pendingNavDateRef = useRef(pendingNavDate)
  useEffect(() => { pendingNavDateRef.current = pendingNavDate }, [pendingNavDate])
  const onCancelNavigationRef = useRef(onCancelNavigation)
  useEffect(() => { onCancelNavigationRef.current = onCancelNavigation }, [onCancelNavigation])

  const save = useCallback(async (explicit = true): Promise<boolean> => {
    if (savingRef.current) return false
    if (loadFailedRef.current) return false
    setSaving(true)
    startSave()
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
      const newModified = saved.entry.updated_at ?? null
      const newId = saved.meta.id
      setSavedTextValue(currentText)
      setBaseVersionValue(newVersion)
      setLastModified(newModified)
      fileIdRef.current = newId
      setStatus(savedStatus)
      success = true
      return true
    } catch (e) {
      if (!explicit) {
        console.error('Auto-save failed:', e)
        return false
      }
      if (e instanceof EntryConflictError) {
        setHasConflict(true)
        setConflictRemote(e.remote)
        setStatus(t.entry.changedElsewhere)
      } else {
        setStatus(t.entry.saveFailed)
      }
      return false
    } finally {
      setSaving(false)
      completeSave(success)
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

  const loadRemote = () => {
    const remoteText = conflictRemote?.entry.content ?? ''
    setText(remoteText)
    setSavedTextValue(remoteText)
    setBaseVersionValue(conflictRemote?.meta.version ?? null)
    setHasConflict(false)
    setConflictRemote(null)
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
    setShowDiscardModal(true)
  }

  const confirmDiscard = () => {
    setText(savedTextRef.current)
    setShowDiscardModal(false)
    setStatus('')
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
    } catch {
      setStatus(t.entry.deleteFailed)
      setShowDeleteModal(false)
    } finally {
      setDeleting(false)
    }
  }

  // Drive auto-save after a short idle period (only when auto-save is enabled)
  useEffect(() => {
    if (!autoSave || !isDirty) return
    const id = window.setTimeout(() => {
      if (savingRef.current || hasConflictRef.current || loadingRef.current) return
      if (loadFailedRef.current) return
      if (textRef.current === savedTextRef.current) return
      save(false)
    }, AUTO_SAVE_MS)
    return () => window.clearTimeout(id)
  }, [text, isDirty, save, autoSave])

  // Ctrl+S / Cmd+S explicit save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (isDirty) handleExplicitSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDirty, handleExplicitSave])

  useEffect(() => {
    if (status !== savedStatus) return

    const clearTimeout = window.setTimeout(() => {
      setStatus(current => current === savedStatus ? '' : current)
    }, SAVED_STATUS_VISIBLE_MS + SAVED_STATUS_EXIT_MS)

    return () => {
      window.clearTimeout(clearTimeout)
    }
  }, [status, savedStatus])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    let frameId: number | null = null

    const updateKeyboardInset = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)

      frameId = window.requestAnimationFrame(() => {
        frameId = null
        const keyboardInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${Math.round(keyboardInset)}px`)
      })
    }

    updateKeyboardInset()
    viewport.addEventListener('resize', updateKeyboardInset)
    viewport.addEventListener('scroll', updateKeyboardInset)

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      viewport.removeEventListener('resize', updateKeyboardInset)
      viewport.removeEventListener('scroll', updateKeyboardInset)
      document.documentElement.style.removeProperty(KEYBOARD_INSET_VAR)
    }
  }, [])

  useEffect(() => {
    if (!showMoreMenu) return
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMoreMenu])

  const [shareMsgVisible, setShareMsgVisible] = useState(false)

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
          setLastModified(result.entry.updated_at ?? null)
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
    <AnimatePresence>
      {showDiscardModal && (
        <motion.dialog
          ref={(node) => {
            if (node) {
              discardDialogRef.current = node
              if (!node.open) node.showModal()
            } else {
              if (discardDialogRef.current?.open) discardDialogRef.current.close()
              discardDialogRef.current = null
            }
          }}
          className="delete-dialog"
          aria-labelledby="discard-dialog-title"
          onCancel={(e) => { e.preventDefault(); setShowDiscardModal(false) }}
          onClick={(e) => { if (e.target === discardDialogRef.current) setShowDiscardModal(false) }}
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        >
          <h3 id="discard-dialog-title">{t.entry.discardTitle}</h3>
          <p>{t.entry.discardDescription}</p>
          <div className="delete-modal-actions">
            <button onClick={() => setShowDiscardModal(false)}>{t.common.cancel}</button>
            <button className="btn-delete" onClick={confirmDiscard}>{t.common.discard}</button>
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
          <button className="btn-menu" onClick={onMenuClick} title={t.entry.openMenu}>☰</button>
          <motion.button className="btn-day-nav" onClick={onPrevDay} aria-label={t.entry.previousDay}
            whileTap={dayNavWhileTap} transition={dayNavTransition}
          >‹</motion.button>
          <h2>
            <span
              className="entry-date-text"
              data-today={isToday || undefined}
              aria-label={isToday ? `${diaryDateLabel(date, true, 'long', locale, true)}${weekday ? ` ${weekday}` : ''}, ${t.common.today}` : undefined}
            >
              <motion.span
                className="dirty-dot"
                initial={false}
                animate={isDirty
                  ? { opacity: 1, width: '0.42rem', marginRight: 0 }
                  : { opacity: 0, width: 0, marginRight: '-0.4rem' }
                }
                transition={{ duration: 0.2, ease: 'easeInOut' }}
              />
              <span className="entry-date-label-full">{diaryDateLabel(date, true, 'long', locale, true)}</span>
              <span className="entry-date-label-short">{diaryDateLabel(date, true, 'short', locale, true)}</span>
              {weekday && <span className="entry-date-weekday">{weekday}</span>}
            </span>
          </h2>
          <motion.button className="btn-day-nav" onClick={onNextDay} aria-label={t.entry.nextDay}
            whileTap={dayNavWhileTap} transition={dayNavTransition}
          >›</motion.button>
        </div>
        <div className="editor-actions">
          <AnimatePresence>
            {isDirty && !loading && !saving && (
              <motion.button
                className="btn-discard"
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
            onClick={handleExplicitSave}
            disabled={saving || !isDirty || loadFailed}
            aria-busy={saving}
            aria-label={saving ? t.entry.saving : status === savedStatus ? t.common.saved : t.entry.save}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={saving ? 'saving' : status === savedStatus ? 'saved' : 'save'}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.11 }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}
              >
                {saving ? <SpinnerIcon /> : status === savedStatus ? <CheckIcon /> : <SaveIcon />}
                <span className="btn-text">{saving ? t.common.savingEllipsis : status === savedStatus ? t.common.saved : t.entry.save}</span>
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <div className="more-menu-container" ref={moreMenuRef}>
            <motion.button className="btn-more" onClick={() => setShowMoreMenu(v => !v)} aria-label={t.entry.moreOptions}
              whileTap={{ scale: 0.88 }}
              transition={{ type: 'spring', stiffness: 600, damping: 25 }}
            >···</motion.button>
            <AnimatePresence>
              {showMoreMenu && (
                <motion.div className="more-menu"
                  initial={{ opacity: 0, scale: 0.91, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.91, y: -6 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  {isSignedIn && fileIdRef.current && (
                    <div className="more-menu-item" onClick={() => { setShowMoreMenu(false); setShowHistoryModal(true) }}>
                      <svg className="btn-icon" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      {t.entry.history}
                    </div>
                  )}
                  {isSignedIn && fileIdRef.current && (
                    <div className="more-menu-item" onClick={() => {
                      setShowMoreMenu(false)
                      window.open(`https://drive.google.com/file/d/${fileIdRef.current}/view`, '_blank')
                    }}>
                      <svg className="btn-icon" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      {t.entry.openInDrive}
                    </div>
                  )}
                  <div
                    className={`more-menu-item${!fileIdRef.current ? ' more-menu-item-disabled' : ''}`}
                    onClick={fileIdRef.current ? handleShareEntry : undefined}
                  >
                    <svg className="btn-icon" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    {t.entry.shareEntry}
                  </div>
                  <div
                    className={`more-menu-item more-menu-delete${!fileIdRef.current ? ' more-menu-item-disabled' : ''}`}
                    onClick={fileIdRef.current ? del : undefined}
                  >
                    <svg className="btn-icon" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    {t.common.delete}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <div className={`editor-meta${loading && !isToday && !isYesterday ? ' editor-meta--loading' : ''}${isFuture ? ' editor-meta--future' : ''}`}>
        {isToday && !lastModified && (
          <>{t.entry.todaysEntry}</>
        )}
        {isToday && lastModified && (
          <>{t.entry.entryLastModified(t.entry.todaysEntry)} <relative-time datetime={lastModified} /></>
        )}
        {isYesterday && !lastModified && (
          <>{t.entry.yesterdaysEntry}</>
        )}
        {isYesterday && lastModified && (
          <>{t.entry.entryLastModified(t.entry.yesterdaysEntry)} <relative-time datetime={lastModified} /></>
        )}
        {isFuture && (
          <>{t.entry.futureEntry}</>
        )}
        {!isToday && !isYesterday && !isFuture && lastModified && (
          <>{t.entry.lastModified} <relative-time datetime={lastModified} /></>
        )}
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
      {pendingNavDate && (
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
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <AnimatePresence initial={false} custom={directionRef.current}>
        <motion.div
          key={date}
          custom={directionRef.current}
          variants={entryVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ type: 'spring', stiffness: 320, damping: 36 }}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
        >
          {loading ? (
            <div className="entry-skeleton" aria-label={t.entry.loadingEntry} aria-live="polite">
              <div className="entry-skeleton-row short" />
              <div className="entry-skeleton-row" />
              <div className="entry-skeleton-row medium" />
              <div className="entry-skeleton-row" />
              <div className="entry-skeleton-row long" />
              <div className="entry-skeleton-row medium" />
            </div>
          ) : loadFailed ? (
            <div className="entry-load-error" role="alert">
              <strong>{t.entry.failedToLoad}</strong>
              <p>{t.entry.failedToLoadHint}</p>
              <button onClick={() => loadFreshEntry()} disabled={refreshing}>
                {refreshing ? t.entry.refreshingEntry : t.entry.refreshEntry}
              </button>
            </div>
          ) : (
            <motion.textarea
              ref={textareaRef}
              className="editor-textarea"
              value={text}
              onChange={e => {
                if (loadFailed) return
                textRef.current = e.target.value
                setText(e.target.value)
                if (status && status !== savedStatus) setStatus('')
              }}
              readOnly={loadFailed}
              placeholder={t.entry.placeholder}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            />
          )}
        </motion.div>
      </AnimatePresence>
      </div>
      {!loading && !loadFailed && (
        <div className="editor-charcount" aria-hidden="true">
          {t.entry.charCount(charCount)}
        </div>
      )}
    </div>
    </>
  )
}
