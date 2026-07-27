import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { EntryConflictError } from '../hooks/useDiary'
import { TokenExpiredError } from '../api/driveEntries'
import { getDraft, deleteDraft } from '../lib/diaryCache'
import type { DraftEntry } from '../lib/diaryCache'
import { MAX_MILESTONE_BADGES, MAX_MILESTONES, type Milestone, type LoadedDiaryEntry, type S3EntrySyncStatus, type S3EntryStatusResult } from '../types'
import { getS3EntryStatus, retryS3EntrySync } from '../api/s3Settings'
import { todayYmd, weekdayLabel, diaryDateLabel, diaryDateParts, milestonesNearEntry, sameMonthDayInPastYears } from '../utils/date'
import { highlightText } from '../utils/highlight'
import { excerpt } from '../utils/text'
import { writingPrompts, appendPrompts } from '../data/writingPrompts'
import { buildDynamicPrompts } from '../utils/dynamicPrompts'
import type { RecurringTopic } from '../utils/topicExtraction'
import { HistoryModal } from './HistoryModal'
import { MilestoneFormModal } from './MilestoneFormModal'
import { shareEntry } from '../utils/share'
import { useI18n } from '../i18n'
import { useSaveProgress } from '../hooks/useSaveProgress'
import { useEvent, useLatestRef } from '../hooks/useEvent'
import { useAutoSave } from '../hooks/useAutoSave'
import { useKeyboardInset } from '../hooks/useKeyboardInset'
import { useFooterInset } from '../hooks/useFooterInset'
import { useScrollEdges } from '../hooks/useScrollEdges'
import { useDismissOnOutside } from '../hooks/useDismissOnOutside'
import { useSwipeNav } from '../hooks/useSwipeNav'
import { useHolidays } from '../hooks/useHolidays'
import type { HolidayCountry } from '../utils/holidays'
import { haptics } from '../utils/haptics'
import { Clock3, CloudUpload, ExternalLink, Flag, Lightbulb, MoreHorizontal, RefreshCw, Share2, Sparkles, Trash2 } from 'lucide-react'

const dayNavWhileTap = { scale: 0.82 }
const dayNavTransition = { type: 'spring' as const, stiffness: 600, damping: 25 }

// Backoff schedule for polling AWS S3 mirror status after a save (~27s total —
// deliberately longer than the server's PENDING_GRACE_MS, ~20s in
// functions/api/s3/entry-status/[date].ts, so the client's last poll always
// lands after the grace window expires. Otherwise a fast save's last poll can
// land just inside the grace window, see 'pending', and stop — stranding the
// badge on a spinner forever since 'pending' offers no retry).
const S3_POLL_DELAYS_MS = [1000, 2000, 3000, 5000, 7000, 9000]
// How long after this tab's own save its `since` timestamp is still trusted
// for a later open-poll of the same date (see lastSaveAtRef) — comfortably
// longer than the server's ~20s pending grace window.
const S3_RECENT_SAVE_CARRY_MS = 30_000
// Cadence used once the server reports 'backfilling' — a large diary's initial
// backfill can take much longer than the bounded schedule above (chunked ~20
// entries per 2s, driven by useS3Backfill), so keep checking back slowly for as
// long as it stays 'backfilling' instead of giving up on a fixed retry count.
const S3_BACKFILL_POLL_INTERVAL_MS = 8000

// Keep the textarea focused (and the mobile keyboard open) when tapping a
// toolbar button, so the keyboard doesn't collapse and shift the toolbar down.
function preventFocusSteal(e: ReactPointerEvent) {
  e.preventDefault()
}

type IdeaCandidate = { kind: 'memory'; date: string } | { kind: 'prompt'; text: string }

// Removes previously-inserted idea/prompt text before the entry's own text is
// scanned for a "mentioned topic" signal, so a re-opened idea panel doesn't
// pick a word out of a question it just suggested (e.g. "mentioned" from a
// prior "You mentioned ... " prompt) instead of the user's actual writing.
function stripInsertedIdeaText(text: string, inserted: readonly string[]): string {
  return inserted.reduce((acc, snippet) => (snippet ? acc.split(snippet).join(' ') : acc), text)
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
  milestones?: Milestone[]
  onMilestoneAdd?: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  relatedDates?: string[]
  onSelectRelated?: (date: string) => void
  getRelatedTokens?: (previewDate: string) => string[]
  getRecurringTopic?: (forDate: string) => RecurringTopic | null
  backDate?: string
  onGoBack?: () => void
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

function DriveBadgeIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 87.3 78" style={{ flexShrink: 0 }}>
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
    </svg>
  )
}

function S3BadgeIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="14.7 23 52 36" style={{ flexShrink: 0 }}>
      <polygon points="27.09 35.764 25.984 40.34 28.182 40.34 27.115 35.764" fill="#F7981F"/>
      <path d="m16.302 40.744v0.666c0 3.311 3.579 6.66 7.991 6.66h23.533c4.412 0 7.991-3.35 7.991-6.66v-0.666c0-3.078-3.098-6.943-7.081-7.283-0.089-2.752-2.342-4.955-5.113-4.955-1.076 0-2.074 0.334-2.898 0.9-1.58-3.52-5.107-5.977-9.216-5.977-5.579 0-10.101 4.521-10.101 10.102 0 0.1 0.012 0.195 0.015 0.293-2.993 0.867-5.121 4.371-5.121 6.92zm12.699 3.055l-0.572-2.275h-2.717l-0.599 2.275h-1.547l2.639-9.283h1.898l2.444 9.283h-1.546zm9.012 0h-1.716l-1.196-6.994h-0.026l-1.183 6.994h-1.716l-1.795-9.283h1.496l1.221 7.215h0.027l1.221-7.215h1.561l1.248 7.254h0.026l1.209-7.254h1.469l-1.846 9.283zm5.433 0.181c-2.301 0-2.821-1.533-2.821-2.834v-0.221h1.482v0.234c0 1.131 0.494 1.703 1.521 1.703 0.936 0 1.403-0.664 1.403-1.354 0-0.975-0.493-1.404-1.325-1.65l-1.015-0.352c-1.353-0.52-1.937-1.221-1.937-2.547 0-1.691 1.144-2.627 2.886-2.627 2.379 0 2.626 1.482 2.626 2.443v0.209h-1.482v-0.195c0-0.846-0.377-1.34-1.3-1.34-0.637 0-1.248 0.352-1.248 1.34 0 0.793 0.403 1.195 1.392 1.572l1 0.365c1.313 0.467 1.886 1.184 1.886 2.457 1e-3 1.979-1.196 2.797-3.068 2.797z" fill="#F7981F"/>
      <path d="m26.205 34.516l-2.639 9.283h1.547l0.599-2.275h2.717l0.572 2.275h1.547l-2.444-9.283h-1.899zm-0.221 5.824l1.105-4.576h0.025l1.066 4.576h-2.196z" fill="#fff"/>
      <polygon points="37.181 41.77 37.154 41.77 35.906 34.516 34.346 34.516 33.125 41.73 33.098 41.73 31.877 34.516 30.381 34.516 32.176 43.799 33.892 43.799 35.074 36.805 35.101 36.805 36.297 43.799 38.013 43.799 39.858 34.516 38.39 34.516" fill="#fff"/>
      <path d="m44.629 38.729l-1-0.365c-0.988-0.377-1.392-0.779-1.392-1.572 0-0.988 0.611-1.34 1.248-1.34 0.923 0 1.3 0.494 1.3 1.34v0.195h1.482v-0.209c0-0.961-0.247-2.443-2.626-2.443-1.742 0-2.886 0.936-2.886 2.627 0 1.326 0.584 2.027 1.937 2.547l1.015 0.352c0.832 0.246 1.325 0.676 1.325 1.65 0 0.689-0.468 1.354-1.403 1.354-1.027 0-1.521-0.572-1.521-1.703v-0.234h-1.482v0.221c0 1.301 0.521 2.834 2.821 2.834 1.872 0 3.068-0.818 3.068-2.795 0-1.276-0.573-1.993-1.886-2.459z" fill="#fff"/>
    </svg>
  )
}

interface SyncBadgeProps {
  status: 'synced' | 'pending' | 'failed' | 'backfilling' | 'unconfirmed'
  title: string
  label: string
  onClick?: () => void
  busy?: boolean
  children: React.ReactNode
}

function SyncBadge({ status, title, label, onClick, busy, children }: SyncBadgeProps) {
  return (
    <div
      className={`editor-meta-badge editor-meta-badge--${status}`}
      title={title}
      aria-label={label}
      aria-busy={busy || undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
    >
      <div className="editor-meta-badge-icon-wrapper">{busy ? <SpinnerIcon /> : children}</div>
      <span className={`editor-meta-badge-status editor-meta-badge-status--${status}`}>
        {status === 'synced' && (
          <svg viewBox="0 0 10 10" className="editor-meta-badge-status-svg">
            <path d="M2.5 5L4.5 7L7.5 3" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
        {status === 'failed' && (
          <svg viewBox="0 0 10 10" className="editor-meta-badge-status-svg">
            <path d="M3 3L7 7M7 3L3 7" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        )}
      </span>
    </div>
  )
}


const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function EntryEditor({ date, getContent, onSave, onDelete, onMenuClick, onDirtyChange, autoSave, onPrevDay, onNextDay, onSelectDate, pendingNavDate, onPendingNavigate, onCancelNavigation, reauthSaveResult, isSignedIn, isOnline, onExpired, onGoToToday, refreshSignal = 0, knownDates, diaryListLoaded, holidayCountry = 'off', milestones = [], onMilestoneAdd, relatedDates, onSelectRelated, getRelatedTokens, getRecurringTopic, backDate, onGoBack }: Props) {
  const { t, locale, language } = useI18n()
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
  const [showMilestoneModal, setShowMilestoneModal] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  // AWS S3 backup status for the currently open entry, polled after a save; null
  // means "not checked yet" or "S3 backup isn't enabled" (s3DisabledRef short-circuits
  // further checks once we learn that, to avoid a status request on every save).
  // A 'disabled' result from the poll is folded into null below (pollS3Status), so
  // this state itself never actually holds 'disabled' — narrow the type to match.
  const [s3Status, setS3Status] = useState<Exclude<S3EntrySyncStatus, 'disabled'> | null>(null)
  const s3DisabledRef = useRef(false)
  const s3PollTokenRef = useRef(0)
  // True while a manual retry of the 'unconfirmed'/'failed' state is in
  // flight (see handleS3Retry below).
  const [s3Retrying, setS3Retrying] = useState(false)

  const [previewDate, setPreviewDate] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [ideaOpen, setIdeaOpen] = useState(false)
  const [ideaIndex, setIdeaIndex] = useState(0)
  const [ideaMemoryContent, setIdeaMemoryContent] = useState<string | null>(null)
  const [ideaMemoryLoading, setIdeaMemoryLoading] = useState(false)
  // Prompt text already inserted via "Use idea" for this date, so it can be
  // excluded when a later pool rebuild scans the entry's own text for a
  // mentioned-topic prompt — otherwise a rebuilt pool tends to pick a word
  // out of the previously-inserted question itself rather than the user's
  // own writing. Reset alongside ideaOpen/ideaIndex on date change below.
  const insertedIdeaTextsRef = useRef<string[]>([])
  const previewDialogRef = useRef<HTMLDialogElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollWrapRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const deleteDialogRef = useRef<HTMLDialogElement>(null)
  const fileIdRef = useRef<string | null>(null)
  // Guards the load effect below against re-running its full reset/reload for a
  // date it has already loaded — see its dateKnownAbsent dependency comment.
  const loadedForDateRef = useRef<string | null>(null)
  // Records when this tab last saved which date, so the load effect's re-poll
  // (fired if it re-runs for a date this tab just saved — e.g. from a future
  // trigger like tab sync) can still pass `since` and get the server's pending
  // grace window, instead of an immediate false 'unconfirmed' verdict.
  const lastSaveAtRef = useRef<{ date: string; at: string } | null>(null)
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
  // 'unconfirmed' and 'failed' are both terminal states nothing will resolve on
  // its own — retrying is offered for both, so both get the 'retrying' label
  // while a retry is in flight.
  const s3Retryable = s3Status === 'unconfirmed' || s3Status === 'failed'
  const s3BadgeLabel = s3Status === 'synced' ? t.entry.s3BadgeSynced
    : s3Status === 'failed' ? (s3Retrying ? t.entry.s3BadgeRetrying : t.entry.s3BadgeFailed)
    : s3Status === 'unconfirmed' ? (s3Retrying ? t.entry.s3BadgeRetrying : t.entry.s3BadgeUnconfirmed)
    : t.entry.s3BadgePending // covers 'pending' and 'backfilling'
  const activeMilestones = useMemo(
    () => (milestones ?? []).filter(a => a.showBadge !== false),
    [milestones],
  )
  const milestoneBadges = useMemo(
    () => milestonesNearEntry(date, activeMilestones).slice(0, MAX_MILESTONE_BADGES),
    [date, activeMilestones],
  )
  const atMilestoneLimit = milestones.length >= MAX_MILESTONES
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

  // Checks /api/s3/entry-status for the AWS S3 mirror status of a given Drive
  // version. Used two ways, both with `retry: true` (default) so a transient
  // STS/S3 hiccup on a single check doesn't strand the badge on "pending"
  // forever: right after a save, with `since` set to when the save attempt
  // started, so backoff attempts can catch the mirror finishing and scope out
  // unrelated stale errors; and when an entry is simply opened/displayed, with
  // no `since` (so any currently-recorded sync error is surfaced immediately,
  // on the first attempt — there's no specific save attempt to scope it
  // against). `token` guards against a stale check (from a previous save/load
  // or a since-abandoned date) clobbering a newer one — see the
  // s3PollTokenRef bump on date change below.
  const pollS3Status = useCallback((forDate: string, version: string | null, since = '', opts: { retry?: boolean } = {}) => {
    if (s3DisabledRef.current || !version) return
    const retry = opts.retry ?? true
    const token = ++s3PollTokenRef.current

    const attempt = async (i: number) => {
      if (s3PollTokenRef.current !== token) return
      const result = await getS3EntryStatus(forDate, version, since).catch(
        (): S3EntryStatusResult => ({ status: 'pending' }),
      )
      if (s3PollTokenRef.current !== token) return
      if (result.status === 'disabled') {
        s3DisabledRef.current = true
        setS3Status(null)
        return
      }
      const exhausted = result.status === 'pending' && i >= S3_POLL_DELAYS_MS.length
      // Ran out of scheduled attempts while still 'pending' — this can happen either
      // because a genuinely in-flight mirror outlasted the schedule (shouldn't happen
      // given the schedule's total comfortably exceeds the server's grace window, but
      // clocks can drift), or because the terminal attempt's own fetch failed and was
      // synthesized as 'pending' by the .catch above rather than reflecting a real
      // server answer. Either way nothing is going to move this forward on its own,
      // and 'pending' offers no retry affordance — surface 'unconfirmed' instead so
      // the badge can be tapped to retry rather than spinning forever.
      setS3Status(exhausted ? 'unconfirmed' : result.status)
      if (!retry) return
      // 'backfilling' means a server-side process is actively working toward this
      // date but may take much longer than a single save's mirror — keep checking
      // back on a slow, unbounded cadence for as long as it stays 'backfilling'
      // rather than giving up and stranding the badge on a spinner the server will
      // never update again on its own.
      if (result.status === 'backfilling') {
        setTimeout(() => { void attempt(i) }, S3_BACKFILL_POLL_INTERVAL_MS)
      } else if (result.status === 'pending' && !exhausted) {
        setTimeout(() => { void attempt(i + 1) }, S3_POLL_DELAYS_MS[i])
      }
    }
    void attempt(0)
  }, [])

  // Clears the S3 badge and (re)polls for a version that just replaced whatever
  // s3Status was describing — used anywhere baseVersion changes outside the main
  // load effect and initial save (a delete, a silent cross-tab/manual refresh, a
  // conflict overwrite, or a reauth-triggered retry save landing): without this,
  // s3Status keeps describing the *previous* version/content indefinitely, e.g.
  // still claiming "Backed up to AWS" for an entry that was just deleted, or for
  // fresh content pulled in from another device that hasn't actually been
  // verified as mirrored yet.
  const resetS3ForVersion = useCallback((forDate: string, newVersion: string | null, since = '') => {
    setS3Status(null)
    if (newVersion) pollS3Status(forDate, newVersion, since)
    else s3PollTokenRef.current += 1 // no new poll to start; just invalidate whatever was in flight
  }, [pollS3Status])

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
    // dateKnownAbsent flips false→true right after this tab's own save of a
    // brand-new date (useDiary.save updates the cache before returning), which
    // re-runs this effect for the *same* date a save() just handled. Without
    // this guard that re-run would reset s3Status and reissue pollS3Status with
    // no `since` (see the entry?.meta.version branch below), invalidating the
    // save-scoped poll started in save() via the s3PollTokenRef bump — the
    // server treats a since-less check as "nothing is actively working on
    // this", returning an immediate false 'unconfirmed' instead of 'pending'.
    if (loadedForDateRef.current === date) return
    loadedForDateRef.current = date

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
    setS3Status(null)
    setS3Retrying(false) // a retry in flight belongs to the date we're leaving, not this one
    s3PollTokenRef.current += 1 // invalidate any in-flight poll for the entry we're leaving
    setDiscardedText(null)
    setIdeaOpen(false)
    setIdeaIndex(0)
    insertedIdeaTextsRef.current = []
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
          if (entry?.meta.version) {
            // Defence in depth alongside the loadedForDateRef guard above: if this
            // tab just saved this exact date, carry that save's `since` into the
            // open-poll so a still-in-flight mirror gets the server's pending
            // grace window instead of an immediate false 'unconfirmed'.
            const recentSave = lastSaveAtRef.current
            const since = recentSave?.date === date && Date.now() - Date.parse(recentSave.at) < S3_RECENT_SAVE_CARRY_MS
              ? recentSave.at : ''
            pollS3Status(date, entry.meta.version, since)
          }
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
  }, [date, applyLoadedEntry, applyDraft, dateKnownAbsent, pollS3Status])

  const directionRef = useRef(0)
  const prevDateRef = useRef(date)
  if (date !== prevDateRef.current) {
    directionRef.current = date > prevDateRef.current ? 1 : -1
    prevDateRef.current = date
  }
  const currentDateRef = useRef(date)
  currentDateRef.current = date

  // Manual retry for the 'unconfirmed'/'failed' terminal states — nothing
  // server-side is going to attempt this date on its own, so re-mirror it on
  // demand and re-poll once that lands. Pins the date at call time: if the
  // user navigates away before the retry lands, the date-change effect above
  // already reset s3Retrying/s3Status for whatever's now open, and polling
  // with a stale date here would otherwise stomp that with the retried
  // date's status under a freshly-issued (and thus "current") poll token.
  const handleS3Retry = useCallback(async () => {
    if (s3Retrying) return
    const retryDate = currentDateRef.current
    setS3Retrying(true)
    try {
      await retryS3EntrySync(retryDate)
    } catch (e) {
      console.error('Failed to retry S3 sync:', e)
    } finally {
      setS3Retrying(false)
    }
    if (currentDateRef.current === retryDate && baseVersionRef.current) {
      pollS3Status(retryDate, baseVersionRef.current)
    }
  }, [s3Retrying, pollS3Status])

  const isDirty = text !== savedText

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => {
    if (!reauthSaveResult || reauthSaveResult.entry.date !== date) return

    const content = reauthSaveResult.entry.content
    const currentText = textRef.current
    const previousSavedText = savedTextRef.current

    const newVersion = reauthSaveResult.meta.version ?? null
    setSavedTextValue(content)
    setBaseVersionValue(newVersion)

    fileIdRef.current = reauthSaveResult.meta.id

    // This landed via a real Drive write (the retried save), which schedules a
    // mirror server-side same as any other save — give it the same since-scoped
    // pending grace window as save()/overwriteRemote instead of an immediate,
    // possibly-false 'unconfirmed' check.
    const attemptStartedAt = new Date().toISOString()
    lastSaveAtRef.current = { date, at: attemptStartedAt }
    resetS3ForVersion(date, newVersion, attemptStartedAt)

    if (currentText === previousSavedText || currentText === content) {
      setText(content)
      setStatus(savedStatus)
    }
  }, [date, reauthSaveResult, savedStatus, setBaseVersionValue, setSavedTextValue, resetS3ForVersion])

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
      // Captured only once the Drive save itself has resolved — the mirror is
      // scheduled server-side after that response, so starting the clock any
      // earlier would burn part of the poll/grace budget on the Drive round
      // trip instead of the mirror's own latency.
      const attemptStartedAt = new Date().toISOString()
      lastSaveAtRef.current = { date, at: attemptStartedAt }
      pollS3Status(date, newVersion, attemptStartedAt)
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
  }, [date, savedStatus, t, setBaseVersionValue, setSavedTextValue, startSave, completeSave, pollS3Status])

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
      const newVersion = saved.meta.version ?? null
      setSavedTextValue(currentText)
      setBaseVersionValue(newVersion)
      setHasConflict(false)
      setConflictRemote(null)
      setPendingOfflineSave(false)
      setStatus(savedStatus)
      // Same rationale as save() above: this is a genuine write, so give the
      // mirror it schedules server-side the same since-scoped pending grace
      // window instead of resetS3ForVersion's default since-less check.
      const attemptStartedAt = new Date().toISOString()
      lastSaveAtRef.current = { date, at: attemptStartedAt }
      resetS3ForVersion(date, newVersion, attemptStartedAt)
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
      resetS3ForVersion(capturedDate, entry?.meta.version ?? null)
      setLoadFailed(false)
      setHasConflict(false)
      setConflictRemote(null)
    } catch {
      if (currentDateRef.current === capturedDate && !silent) setStatus(t.entry.failedToRefresh)
    } finally {
      if (currentDateRef.current === capturedDate && !silent) setRefreshing(false)
    }
  }, [date, applyLoadedEntry, resetS3ForVersion])

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
      resetS3ForVersion(date, null)
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
  useFooterInset(footerRef)

  const closeMoreMenu = useCallback(() => {
    setShowMoreMenu(false)
  }, [])
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

  useEffect(() => {
    if (!previewDate) return
    setPreviewContent(null)
    setPreviewLoading(true)
    let cancelled = false
    getContent(previewDate)
      .then(result => {
        if (!cancelled) {
          setPreviewContent(result?.entry.content ?? '')
          setPreviewLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewContent('')
          setPreviewLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [previewDate, getContent])

  useEffect(() => {
    const dialog = previewDialogRef.current
    if (!dialog) return
    if (previewDate) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [previewDate])

  const pastIdeaDates = useMemo(
    () => (knownDates ? sameMonthDayInPastYears(Array.from(knownDates), date) : []),
    [knownDates, date]
  )

  const isEntryEmpty = text.trim().length === 0

  // The idea UI is always available, but its candidate pool is only worth
  // (re)building while empty (the original "need an idea?" case) or while the
  // panel is actually open — recomputing the recurring-topic scan on every
  // autosave-triggered index rebuild while the user is mid-sentence would be
  // wasteful, and nobody's looking at the pool until they open it anyway.
  const shouldBuildIdeas = isEntryEmpty || ideaOpen

  // Signals derived from the user's own history/calendar rather than a fixed
  // list — milestone proximity, entry cadence, weekday/season, holidays, and
  // a topic they used to write about but haven't lately. Reused as-is once an
  // entry already has content: these ask about the day in general, not about
  // starting to write, so they read fine as an append nudge too. Once there's
  // content, a snapshot of it (via textRef, not the reactive `text` state) is
  // also passed in so one signal can reference something the user actually
  // just wrote — snapshotted rather than live so typing while the idea card
  // is open doesn't reshuffle the pool underneath the user. Text from a
  // previously-inserted idea is stripped out first, so a rebuilt pool picks a
  // word out of what the user actually wrote rather than echoing a word back
  // from the question that was just appended.
  const dynamicPrompts = useMemo(
    () => (shouldBuildIdeas ? buildDynamicPrompts({
      date,
      knownDates: knownDates ? Array.from(knownDates) : [],
      milestones: activeMilestones,
      holiday: yearHolidays[date],
      recurringTopic: getRecurringTopic?.(date) ?? null,
      currentText: isEntryEmpty ? undefined : stripInsertedIdeaText(textRef.current, insertedIdeaTextsRef.current),
      language,
    }) : []),
    [shouldBuildIdeas, date, knownDates, activeMilestones, yearHolidays, getRecurringTopic, language, isEntryEmpty]
  )

  // Curated fallback so the pool is never empty for a brand-new or sparse
  // account — a "start from scratch" bank while empty, an "add to what's
  // there" bank once the entry already has content.
  const staticPrompts = useMemo(() => {
    const bank = (isEntryEmpty ? writingPrompts : appendPrompts)[language] ?? (isEntryEmpty ? writingPrompts.en : appendPrompts.en)
    const shuffled = [...bank]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, 4)
  }, [language, date, isEntryEmpty])

  // Memory, dynamic, and static candidates are shuffled together into one pool
  // (rather than a strict fallback chain) so the same tier doesn't always lead,
  // and reshuffled only once per date so re-renders don't reorder it under the user.
  const ideaCandidates = useMemo<IdeaCandidate[]>(() => {
    const pool: IdeaCandidate[] = [
      ...pastIdeaDates.map(d => ({ kind: 'memory' as const, date: d })),
      ...dynamicPrompts.map(text => ({ kind: 'prompt' as const, text })),
      ...staticPrompts.map(text => ({ kind: 'prompt' as const, text })),
    ]
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    return pool
  }, [pastIdeaDates, dynamicPrompts, staticPrompts])

  const currentIdea = ideaCandidates[ideaIndex % ideaCandidates.length] ?? null

  useEffect(() => {
    if (!ideaOpen || !currentIdea || currentIdea.kind !== 'memory') { setIdeaMemoryContent(null); return }
    let cancelled = false
    setIdeaMemoryLoading(true)
    getContent(currentIdea.date)
      .then(result => {
        if (!cancelled) { setIdeaMemoryContent(result?.entry.content ?? ''); setIdeaMemoryLoading(false) }
      })
      .catch(() => {
        if (!cancelled) { setIdeaMemoryContent(''); setIdeaMemoryLoading(false) }
      })
    return () => { cancelled = true }
  }, [ideaOpen, currentIdea, getContent])

  const handleShuffleIdea = () => setIdeaIndex(i => (i + 1) % ideaCandidates.length)

  const handleUseIdea = () => {
    if (!currentIdea || currentIdea.kind !== 'prompt') return
    const base = textRef.current
    const next = base.trim().length === 0
      ? `${currentIdea.text}\n\n`
      : `${base.replace(/\s+$/, '')}\n\n${currentIdea.text}\n\n`
    textRef.current = next
    setText(next)
    insertedIdeaTextsRef.current = [...insertedIdeaTextsRef.current, currentIdea.text].slice(-20)
    if (status && status !== savedStatus) setStatus('')
    setIdeaOpen(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) { el.focus(); el.setSelectionRange(next.length, next.length) }
    })
  }

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
    {showMilestoneModal && onMilestoneAdd && (
      <MilestoneFormModal
        mode="add"
        initialDate={date}
        onSave={(label, milestoneDate, emoji, recurring) => {
          onMilestoneAdd(label, milestoneDate, emoji, recurring)
          setShowMilestoneModal(false)
        }}
        onClose={() => setShowMilestoneModal(false)}
        t={t}
      />
    )}
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
            aria-label={saving ? t.entry.saving : status === savedStatus ? t.entry.savedToDrive : autoSave ? t.entry.autoSave : t.entry.save}
            title={autoSave ? undefined : isMac ? '⌘S' : 'Ctrl+S'}
            data-autosave={autoSave || undefined}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
              {saving ? <SpinnerIcon /> : status === savedStatus ? <CheckIcon /> : <SaveIcon />}
              <span className="btn-text">{saving ? t.common.savingEllipsis : status === savedStatus ? t.entry.savedToDrive : autoSave ? t.entry.autoSave : t.entry.save}</span>
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
                  <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: 0.1 }}
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
                    {onMilestoneAdd && (
                      <button
                        type="button"
                        className={`more-menu-item${atMilestoneLimit ? ' more-menu-item-disabled' : ''}`}
                        disabled={atMilestoneLimit}
                        title={atMilestoneLimit ? t.entry.milestoneAtLimit : undefined}
                        onClick={() => { if (!atMilestoneLimit) { setShowMoreMenu(false); setShowMilestoneModal(true) } }}
                      >
                        <Flag className="btn-icon" aria-hidden="true" size={15} strokeWidth={2} />
                        {t.entry.addAsMilestone}
                      </button>
                    )}
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
        {milestoneBadges.map(({ id, label, date: milestoneDate, distance, emoji, nthYear }) => (
          <button
            key={id}
            type="button"
            className={`editor-meta-milestone${distance === 0 ? ' editor-meta-milestone--on' : ''}`}
            onClick={() => onSelectDate(milestoneDate)}
            aria-label={t.entry.milestoneOpen(label, milestoneDate)}
          >
            {emoji ?? '🎀'}{' '}
            {distance === 0 ? t.entry.milestoneOn(label, nthYear)
             : distance > 0 ? t.entry.milestoneBefore(label, distance, nthYear)
             : t.entry.milestoneAfter(label, Math.abs(distance), nthYear)}
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
        <div className="editor-meta-sync">
          <AnimatePresence initial={false}>
            {!isDirty && !loading && !loadFailed && baseVersion !== null && (
              <motion.span
                key="drive"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <SyncBadge
                  status="synced"
                  title={t.entry.driveBadge}
                  label={t.entry.driveBadge}
                >
                  <DriveBadgeIcon />
                </SyncBadge>
              </motion.span>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {!isDirty && !loading && !loadFailed && s3Status && (
              <motion.span
                key="s3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <SyncBadge
                  status={s3Status}
                  title={s3BadgeLabel}
                  label={s3BadgeLabel}
                  onClick={s3Retryable && !s3Retrying ? handleS3Retry : undefined}
                  busy={s3Retrying}
                >
                  <S3BadgeIcon />
                </SyncBadge>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
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
      {backDate && (
        <button className="editor-back-bar" onClick={onGoBack} onPointerDown={preventFocusSteal}>
          {t.entry.backTo(diaryDateLabel(backDate, true, 'short', locale))}
        </button>
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
      <div className="editor-footer" ref={footerRef}>
      {!loading && !loadFailed && !isNewEmptyEntry && (
        <div className="editor-charcount" aria-hidden="true">
          {t.entry.charCount(charCount)}
        </div>
      )}
      {!loading && !loadFailed && (
        <div className="editor-idea">
          {!ideaOpen ? (
            <button
              type="button"
              className="editor-idea-trigger"
              onClick={() => setIdeaOpen(true)}
              onPointerDown={preventFocusSteal}
            >
              <Lightbulb size={13} strokeWidth={1.8} aria-hidden="true" />
              {t.entry.wantIdea}
            </button>
          ) : currentIdea && (
            <div className="editor-idea-card">
              {currentIdea.kind === 'memory' ? (
                <>
                  <p className="editor-idea-text">
                    {t.recollection.hintOnThisDay(Number(date.slice(0, 4)) - Number(currentIdea.date.slice(0, 4)))}
                  </p>
                  {ideaMemoryLoading ? (
                    <div className="editor-idea-skeleton" aria-hidden="true" />
                  ) : (
                    <p className="editor-idea-excerpt">{excerpt(ideaMemoryContent ?? '', 160)}</p>
                  )}
                  <div className="editor-idea-actions">
                    <button
                      type="button"
                      className="editor-idea-action"
                      onClick={() => setPreviewDate(currentIdea.date)}
                      onPointerDown={preventFocusSteal}
                    >
                      {t.entry.ideaViewFull}
                    </button>
                    {ideaCandidates.length > 1 && (
                      <button
                        type="button"
                        className="editor-idea-icon-btn"
                        aria-label={t.entry.ideaAnother}
                        onClick={handleShuffleIdea}
                        onPointerDown={preventFocusSteal}
                      >
                        <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="editor-idea-icon-btn"
                      aria-label={t.common.close}
                      onClick={() => setIdeaOpen(false)}
                      onPointerDown={preventFocusSteal}
                    >×</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="editor-idea-text">{currentIdea.text}</p>
                  <div className="editor-idea-actions">
                    <button
                      type="button"
                      className="editor-idea-action"
                      onClick={handleUseIdea}
                      onPointerDown={preventFocusSteal}
                    >
                      {isEntryEmpty ? t.entry.ideaUsePrompt : t.entry.ideaUsePromptAppend}
                    </button>
                    {ideaCandidates.length > 1 && (
                      <button
                        type="button"
                        className="editor-idea-icon-btn"
                        aria-label={t.entry.ideaAnother}
                        onClick={handleShuffleIdea}
                        onPointerDown={preventFocusSteal}
                      >
                        <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="editor-idea-icon-btn"
                      aria-label={t.common.close}
                      onClick={() => setIdeaOpen(false)}
                      onPointerDown={preventFocusSteal}
                    >×</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      </div>
      {relatedDates && relatedDates.length > 0 && !loading && !loadFailed && (
        <div className="editor-related">
          <span className="editor-related-label"><Sparkles size={11} strokeWidth={1.8} aria-hidden="true" />{t.entry.relatedEntries}</span>
          <div className="editor-related-list">
            {relatedDates.map(d => (
              <button
                key={d}
                className="editor-related-item"
                onClick={() => setPreviewDate(d)}
                onPointerDown={preventFocusSteal}
              >
                {diaryDateLabel(d, true, 'short', locale)}
              </button>
            ))}
          </div>
        </div>
      )}
      <dialog
        ref={previewDialogRef}
        className="related-preview-dialog"
        onCancel={e => { e.preventDefault(); setPreviewDate(null) }}
        onClick={e => { if (e.target === previewDialogRef.current) setPreviewDate(null) }}
      >
        <div className="related-preview-header">
          <span className="related-preview-date">
            {previewDate && diaryDateLabel(previewDate, true, 'long', locale, false, true)}
          </span>
          <button
            className="related-preview-close"
            onClick={() => setPreviewDate(null)}
            aria-label={t.common.close}
          >×</button>
        </div>
        <div className="related-preview-body">
          {previewLoading ? (
            <div className="entry-skeleton" aria-label={t.entry.loadingEntry} aria-live="polite">
              <div className="entry-skeleton-row short" />
              <div className="entry-skeleton-row" />
              <div className="entry-skeleton-row medium" />
            </div>
          ) : previewContent ? (
            <p className="related-preview-content">
              {highlightText(
                previewContent,
                previewDate && getRelatedTokens ? getRelatedTokens(previewDate) : [],
              ).map((seg, i) =>
                typeof seg === 'string'
                  ? seg
                  : <mark key={i} className="related-preview-highlight">{seg.text}</mark>
              )}
            </p>
          ) : previewDate ? (
            <p className="related-preview-empty">{t.entry.placeholder}</p>
          ) : null}
        </div>
        <div className="related-preview-actions">
          <button
            className="related-preview-open"
            onClick={() => {
              if (previewDate) (onSelectRelated ?? onSelectDate)(previewDate)
              setPreviewDate(null)
            }}
          >
            {t.entry.openThisEntry}
          </button>
        </div>
      </dialog>
    </div>
    </>
  )
}
