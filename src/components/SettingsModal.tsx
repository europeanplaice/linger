import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { ExportButton } from './ExportButton'
import { ImportButton } from './ImportButton'
import { SettingsSelect } from './SettingsSelect'
import { MilestoneFormModal } from './MilestoneFormModal'
import { shareApp } from '../utils/share'
import { useI18n } from '../i18n'
import type { ThemeMode } from '../hooks/useTheme'
import type { AccentColor } from '../hooks/useAccentColor'
import type { FontSize } from '../hooks/useFontSize'
import type { ImportResult } from '../hooks/useDiary'
import type { HolidayCountry } from '../utils/holidays'
import { HOLIDAY_COUNTRY_CODES, isHolidayCountry } from '../utils/holidays'
import { loadS3Settings, saveS3Settings, testS3Settings, precheckS3Settings, retryS3Backfill, resyncS3Backfill, listS3RestoreCandidates, restoreS3Entry } from '../api/s3Settings'

import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  type Milestone,
  type S3Settings,
  type BackfillProgress,
} from '../types'

const SETTINGS_SECTIONS: {
  id: string
  labelKey: 'navAccount' | 'navAppearance' | 'navCalendar' | 'navMilestones' | 'navData' | 'navBackup'
  className?: string
}[] = [
  { id: 'settings-account', labelKey: 'navAccount' },
  { id: 'settings-appearance', labelKey: 'navAppearance' },
  { id: 'settings-calendar', labelKey: 'navCalendar' },
  { id: 'settings-milestones', labelKey: 'navMilestones' },
  { id: 'settings-data', labelKey: 'navData' },
  { id: 'settings-backup', labelKey: 'navBackup' },
]

function AppliedChip() {
  const { t } = useI18n()
  return <span className="settings-applied-chip">{t.settings.applied}</span>
}

function InfoTip({ text }: { text: string }) {
  const { t } = useI18n()
  const popId = useId()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    popRef.current?.hidePopover()
    setOpen(false)
    btnRef.current?.focus()
  }, [])

  const toggle = useCallback(() => {
    if (open) { close(); return }
    const btn = btnRef.current!
    const pop = popRef.current!
    const rect = btn.getBoundingClientRect()
    pop.style.top = `${rect.bottom + 6}px`
    pop.style.left = `${Math.max(8, Math.min(rect.left - 8, window.innerWidth - 240))}px`
    if ('showPopover' in HTMLElement.prototype) pop.showPopover()
    setOpen(true)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent | TouchEvent) => {
      const target = (e.target ?? (e as TouchEvent).touches?.[0]?.target) as Node | null
      if (!btnRef.current?.contains(target) && !popRef.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('touchstart', handle)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('touchstart', handle)
    }
  }, [open, close])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`infotip-btn${open ? ' open' : ''}`}
        aria-label={t.settings.infoTipLabel}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); close() } }}
      ><Info size={13} strokeWidth={2} aria-hidden="true" /></button>
      <div
        ref={popRef}
        id={popId}
        popover="manual"
        className="infotip-popover"
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}
      >{text}</div>
    </>
  )
}

function SpinnerIcon() {
  return <span className="btn-saving-spinner" aria-hidden="true" />
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  )
}

function ErrorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  )
}

interface SettingsModalProps {
  autoSave: boolean
  onAutoSaveToggle: () => void
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  accentColor: AccentColor
  onAccentChange: (color: AccentColor) => void
  fontMode: 'serif' | 'sans'
  onFontToggle: () => void
  fontSize: FontSize
  onFontSizeChange: (size: FontSize) => void
  holidayCountry: HolidayCountry
  onHolidayCountryChange: (country: HolidayCountry) => void
  dates: string[]
  onExport: (onProgress: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
  onImport: (entries: { date: string; content: string }[], onProgress: (done: number, total: number) => void) => Promise<ImportResult>
  onClose: () => void
  onSignOut: () => void
  email?: string
  googleSub?: string
  googleClientId?: string
  milestones?: Milestone[]
  onMilestoneAdd?: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneUpdate?: (id: string, label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneRemove?: (id: string) => void
  onMilestoneToggleBadge?: (id: string) => void
  // S3 backfill progress lives in the useS3Backfill hook at the App level so it keeps
  // advancing while this modal is closed — this modal only displays it and triggers it.
  s3BackfillProgress: BackfillProgress | null
  s3LastSyncError: string | null
  s3LastSyncErrorAt: string | null
  s3BackfillActive: boolean
  onS3StartBackfill: () => void
  onS3ClearSyncError: () => void
  // Called after an entry is recreated in Drive from the S3 backup, so the
  // calendar/list refreshes and the restored entry becomes visible.
  onEntryRestored?: () => void
}

export function SettingsModal({ autoSave, onAutoSaveToggle, themeMode, onThemeModeChange, accentColor, onAccentChange, fontMode, onFontToggle, fontSize, onFontSizeChange, holidayCountry, onHolidayCountryChange, dates, onExport, onImport, onClose, onSignOut, email, googleSub, googleClientId, milestones = [], onMilestoneAdd, onMilestoneUpdate, onMilestoneRemove, onMilestoneToggleBadge, s3BackfillProgress, s3LastSyncError, s3LastSyncErrorAt, s3BackfillActive, onS3StartBackfill, onS3ClearSyncError, onEntryRestored }: SettingsModalProps) {
  const { t, locale, language, setLanguage } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<Milestone | null>(null)
  const [milestoneModal, setMilestoneModal] = useState<{ mode: 'add' | 'edit'; milestone?: Milestone } | null>(null)
  const [listExpanded, setListExpanded] = useState(true)
  const milestoneLimitId = useId()
  const badgeLimitId = useId()
  const enabledBadgeCount = milestones.filter(a => a.showBadge !== false).length
  const milestoneLimitReached = milestones.length >= MAX_MILESTONES

  // Localized country names come from Intl, so no hardcoded country dictionary.
  const holidayOptions = useMemo(() => {
    let regionNames: Intl.DisplayNames | null = null
    try {
      regionNames = new Intl.DisplayNames([locale], { type: 'region' })
    } catch {
      regionNames = null
    }
    return [
      { value: 'off', label: t.settings.holidayCountryOff },
      ...HOLIDAY_COUNTRY_CODES.map(code => ({ value: code, label: regionNames?.of(code) ?? code })),
    ]
  }, [locale, t])
  const dialogRef = useRef<HTMLDialogElement>(null)
  const signOutDialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0].id)
  const [appliedFlash, setAppliedFlash] = useState<string | null>(null)
  const appliedFlashTimer = useRef<number | undefined>(undefined)
  const flashApplied = useCallback((key: string) => {
    setAppliedFlash(key)
    if (appliedFlashTimer.current !== undefined) window.clearTimeout(appliedFlashTimer.current)
    appliedFlashTimer.current = window.setTimeout(() => setAppliedFlash(null), 1200)
  }, [])
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false)
  const [s3Enabled, setS3Enabled] = useState(false)
  const [s3RoleArn, setS3RoleArn] = useState('')
  const [s3Bucket, setS3Bucket] = useState('')
  const [s3Region, setS3Region] = useState('')
  const [s3SaveState, setS3SaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [s3TestState, setS3TestState] = useState<'idle' | 'testing' | 'ok' | 'error' | 'invalid'>('idle')
  const [s3TestError, setS3TestError] = useState<string | null>(null)
  // Populated by handleS3Test alongside a successful connectivity check, but only on the
  // first-time-enable path — the same case handleS3SaveClick's own precheck guards. Lets
  // Test answer "is this safe to Save" up front instead of only warning after the fact.
  const [s3TestCollisions, setS3TestCollisions] = useState<string[] | null>(null)
  const [s3Retrying, setS3Retrying] = useState(false)
  const [s3Resyncing, setS3Resyncing] = useState(false)
  // Tracks the enabled value as of the last load/save, so we know whether the next Save
  // is a first-time enable (the only time the backfill precheck below needs to run).
  const [s3InitiallyEnabled, setS3InitiallyEnabled] = useState(false)
  const [s3Prechecking, setS3Prechecking] = useState(false)
  const [s3OverwriteConfirmOpen, setS3OverwriteConfirmOpen] = useState(false)
  const [s3Collisions, setS3Collisions] = useState<string[]>([])
  const [copiedField, setCopiedField] = useState<'sub' | 'clientId' | null>(null)
  const s3OverwriteDialogRef = useRef<HTMLDialogElement>(null)
  const [s3SetupOpen, setS3SetupOpen] = useState(true)
  const s3SetupTouched = useRef(false)
  // Dates that exist in the bucket but not in Drive (null = not loaded yet).
  const [s3RestoreCandidates, setS3RestoreCandidates] = useState<string[] | null>(null)
  const [s3RestoreLoading, setS3RestoreLoading] = useState(false)
  const [s3RestoringDate, setS3RestoringDate] = useState<string | null>(null)
  const [s3RestoreError, setS3RestoreError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadS3Settings().then(settings => {
      if (cancelled || !settings) return
      setS3Enabled(settings.enabled)
      setS3InitiallyEnabled(settings.enabled)
      setS3RoleArn(settings.roleArn)
      setS3Bucket(settings.bucket)
      setS3Region(settings.region)
      // Once S3 is configured the long setup walkthrough is a distraction — collapse
      // it unless the user has already opened/closed it manually this session.
      if (settings.enabled && !s3SetupTouched.current) setS3SetupOpen(false)
    }).catch(e => console.error('Failed to load S3 settings:', e))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const dialog = s3OverwriteDialogRef.current
    if (!dialog) return
    if (s3OverwriteConfirmOpen) {
      dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [s3OverwriteConfirmOpen])

  // Load the restore candidates whenever S3 backup is known to be enabled — both
  // on open (settings loaded in the effect above) and right after a first-time
  // enable, so the "entries missing from Drive" list is fresh. Disabled → clear.
  const loadS3RestoreCandidates = useCallback(async () => {
    setS3RestoreLoading(true)
    setS3RestoreError(null)
    try {
      setS3RestoreCandidates(await listS3RestoreCandidates())
    } catch (e) {
      console.error('Failed to load S3 restore candidates:', e)
      setS3RestoreCandidates([])
      setS3RestoreError(t.settings.s3RestoreFailed)
    } finally {
      setS3RestoreLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!s3InitiallyEnabled) {
      setS3RestoreCandidates(null)
      setS3RestoreError(null)
      return
    }
    void loadS3RestoreCandidates()
  }, [s3InitiallyEnabled, loadS3RestoreCandidates])

  const handleS3Restore = useCallback(async (date: string) => {
    if (s3RestoringDate) return
    setS3RestoringDate(date)
    setS3RestoreError(null)
    try {
      const result = await restoreS3Entry(date)
      if (!result.ok) {
        setS3RestoreError(result.error ?? t.settings.s3RestoreFailed)
        return
      }
      setS3RestoreCandidates(prev => (prev ?? []).filter(d => d !== date))
      onEntryRestored?.()
    } catch (e) {
      console.error('Failed to restore S3 entry:', e)
      setS3RestoreError(t.settings.s3RestoreFailed)
    } finally {
      setS3RestoringDate(null)
    }
  }, [s3RestoringDate, onEntryRestored, t])

  // Scroll-spy for the section index nav: the active tab follows whichever
  // section's top edge has crossed into the top of the scrollable list.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onScroll = () => {
      const listTop = list.getBoundingClientRect().top
      let current = SETTINGS_SECTIONS[0].id
      for (const s of SETTINGS_SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top - listTop <= 60) current = s.id
      }
      setActiveSection(current)
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => list.removeEventListener('scroll', onScroll)
  }, [])

  // The Role ARN / bucket / region are exactly what Save persists and Test
  // checks — once any of them changes, a prior "Saved"/"Connected" result no
  // longer describes the current form, so clear it rather than leave a stale
  // success state on screen.
  const handleS3FieldChange = useCallback((setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value)
    setS3SaveState('idle')
    setS3TestState('idle')
    setS3TestError(null)
    setS3TestCollisions(null)
  }, [])

  const handleS3EnabledChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setS3Enabled(e.target.checked)
    setS3SaveState('idle')
    // Whether collisions matter at all depends on this checkbox (only the first-time-enable
    // path checks them), so a stale warning from before the toggle would be misleading.
    setS3TestCollisions(null)
  }, [])

  const handleS3Save = useCallback(async () => {
    setS3SaveState('saving')
    setS3TestState('idle')
    try {
      const settings: S3Settings = { enabled: s3Enabled, roleArn: s3RoleArn.trim(), bucket: s3Bucket.trim(), region: s3Region.trim() }
      const isFirstTimeEnable = s3Enabled && !s3InitiallyEnabled
      await saveS3Settings(settings)
      setS3SaveState('saved')
      setS3InitiallyEnabled(s3Enabled)
      // Saving rewrites the whole settings file without sync-status fields, so the
      // stored error is cleared server-side too — mirror that locally right away.
      onS3ClearSyncError()
      if (isFirstTimeEnable) {
        onS3StartBackfill()
      }
      setTimeout(() => setS3SaveState('idle'), 2000)
    } catch (e) {
      console.error('Failed to save S3 settings:', e)
      setS3SaveState('error')
    }
  }, [s3Enabled, s3InitiallyEnabled, s3RoleArn, s3Bucket, s3Region, onS3ClearSyncError, onS3StartBackfill])

  const handleS3RetryBackfill = useCallback(async () => {
    setS3Retrying(true)
    try {
      await retryS3Backfill()
      onS3StartBackfill()
    } catch (e) {
      console.error('Failed to retry S3 backfill:', e)
    } finally {
      setS3Retrying(false)
    }
  }, [onS3StartBackfill])

  // Unlike handleS3RetryBackfill (just the previously-failed dates), this re-mirrors
  // every entry — the only way to recover an entry whose per-save mirror silently missed
  // without ever being recorded in backfillProgress.failed (e.g. a dropped Google
  // id_token on refresh outliving that one save). Safe to run any time: putObjectIfNewer
  // skips anything already at least as new as Drive.
  const handleS3Resync = useCallback(async () => {
    setS3Resyncing(true)
    try {
      await resyncS3Backfill()
      onS3StartBackfill()
    } catch (e) {
      console.error('Failed to start S3 resync:', e)
    } finally {
      setS3Resyncing(false)
    }
  }, [onS3StartBackfill])

  // The very first time backup is enabled, the server does a one-shot backfill that
  // overwrites any diary-*.txt object already sitting at a colliding key — including
  // files that were never written by linger. Check for that before saving so the user
  // can back out instead of finding out after the fact. Re-enabling later (once
  // s3InitiallyEnabled is already true) skips this, since a fresh backfill isn't
  // triggered again.
  const handleS3SaveClick = useCallback(async () => {
    if (s3Enabled && !s3InitiallyEnabled) {
      setS3Prechecking(true)
      try {
        const result = await precheckS3Settings({ roleArn: s3RoleArn.trim(), bucket: s3Bucket.trim(), region: s3Region.trim() })
        if (result.ok && result.collisions && result.collisions.length > 0) {
          setS3Collisions(result.collisions)
          setS3OverwriteConfirmOpen(true)
          return
        }
      } catch (e) {
        // A failed precheck shouldn't block Save — any real problem (bad Role ARN,
        // no bucket access, etc.) surfaces the same way it always did, via Save/the
        // background backfill's own error handling.
        console.error('S3 precheck failed:', e)
      } finally {
        setS3Prechecking(false)
      }
    }
    await handleS3Save()
  }, [s3Enabled, s3InitiallyEnabled, s3RoleArn, s3Bucket, s3Region, handleS3Save])

  const handleS3Test = useCallback(async () => {
    const missing: string[] = []
    if (!s3Bucket.trim()) missing.push(t.settings.s3Bucket)
    if (!s3Region.trim()) missing.push(t.settings.s3Region)
    if (!s3RoleArn.trim()) missing.push(t.settings.s3RoleArn)
    if (missing.length > 0) {
      setS3TestState('invalid')
      setS3TestError(t.settings.s3RequiredFieldsMissing(missing))
      return
    }
    setS3TestState('testing')
    setS3TestError(null)
    setS3TestCollisions(null)
    const trimmed = { roleArn: s3RoleArn.trim(), bucket: s3Bucket.trim(), region: s3Region.trim() }
    // Collisions only matter on the first-time-enable path (see handleS3SaveClick) — run
    // it alongside the connectivity check there so Test surfaces the same risk Save would
    // otherwise only reveal after the fact, without slowing down a routine re-test.
    const checkCollisions = s3Enabled && !s3InitiallyEnabled
    try {
      const [result, precheck] = await Promise.all([
        testS3Settings(trimmed),
        checkCollisions ? precheckS3Settings(trimmed).catch(e => {
          console.error('S3 collision precheck (via Test) failed:', e)
          return null
        }) : Promise.resolve(null),
      ])
      if (result.ok) {
        setS3TestState('ok')
        if (precheck?.ok) setS3TestCollisions(precheck.collisions ?? [])
      } else {
        setS3TestState('error')
        setS3TestError(result.error ?? null)
      }
    } catch (e) {
      console.error('S3 connection test failed:', e)
      setS3TestState('error')
      setS3TestError(null)
    }
  }, [s3RoleArn, s3Bucket, s3Region, s3Enabled, s3InitiallyEnabled, t])

  // Save, Resync, and Retry all end up overwriting the same server-side
  // s3_settings.json (see saveS3Settings / resyncS3Backfill / retryS3Backfill) with
  // no optimistic-concurrency check, so running any two of them at once can corrupt
  // backfillProgress or (for Save specifically) redirect an in-flight backfill's
  // remaining chunks to a newly-saved bucket/region mid-run. Test doesn't touch that
  // file, but it shares the same role-assumption call path, so it's folded into the
  // same flag too — gate all four behind one shared flag rather than each button only
  // guarding its own state.
  const s3SyncBusy = s3SaveState === 'saving' || s3Prechecking || s3Resyncing || s3Retrying || s3BackfillActive || s3TestState === 'testing'

  // Names which of the operations folded into s3SyncBusy is the one actually running, so a
  // disabled button's tooltip can say what it's waiting on instead of just "something else is
  // running". s3BackfillActive alone (no local flag set) means the one-shot backfill kicked off
  // by a first-time-enable Save is what's running — that's not distinguishable from a Resync
  // once the Resync/Retry click that started it has already reset its own local flag.
  const s3BusyOpLabel = s3TestState === 'testing' ? t.settings.s3OpTest
    : s3SaveState === 'saving' || s3Prechecking ? t.settings.s3OpSave
    : s3Resyncing ? t.settings.s3OpResync
    : s3Retrying ? t.settings.s3OpRetry
    : s3BackfillActive ? t.settings.s3OpBackfill
    : null

  // The checkbox reading "Enable S3 backup" implies checking it takes effect immediately,
  // but nothing happens until this button is pressed — name the button after what it will
  // actually do (turn backup on/off, or just persist an edit to an already-enabled setup)
  // instead of a generic "Save" that leaves that ambiguous.
  const s3SaveLabel = s3Enabled && !s3InitiallyEnabled ? t.settings.s3SaveEnable
    : !s3Enabled && s3InitiallyEnabled ? t.settings.s3SaveDisable
    : s3Enabled && s3InitiallyEnabled ? t.settings.s3SaveChanges
    : t.settings.s3Save

  const handleCopy = useCallback((field: 'sub' | 'clientId', value: string | undefined) => {
    if (!value) return
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    }).catch(() => {})
  }, [])

  const handleDownloadTfvars = useCallback(() => {
    const lines = [
      `aws_region = "${s3Region.trim() || 'us-east-1'}"`,
      '',
      '# Must be globally unique across all of AWS — a plausible-looking name like',
      '# "my-linger-diary" will almost always already be taken by someone else. Try',
      '# appending your AWS account ID or a random suffix.',
      `bucket_name = "${s3Bucket.trim() || 'CHANGE-ME-linger-diary-<your-aws-account-id-or-random-suffix>'}"`,
      '',
      '# Not secret, but changes rarely — get this from linger\'s Settings or the operator.',
      `linger_google_client_id = "${googleClientId || 'YOUR_LINGER_GOOGLE_GOOGLE_CLIENT_ID.apps.googleusercontent.com'}"`,
      '',
      '# Your own Google account\'s stable numeric ID (the \'sub\' claim, digits only,',
      '# e.g. "112233445566778899001"), not your email. This is the same value shown',
      '# as "Your Google account ID" in linger\'s Settings under S3 backup (advanced).',
      '# Without this, any signed-in linger user could assume this role.',
      `linger_google_sub = "${googleSub || 'YOUR_GOOGLE_ACCOUNT_ID_FROM_LINGER_SETTINGS'}"`,
    ]
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'terraform.tfvars'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [googleClientId, googleSub, s3Region, s3Bucket])

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  useEffect(() => {
    const dialog = signOutDialogRef.current
    if (!dialog) return
    if (signOutConfirmOpen) {
      dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [signOutConfirmOpen])

  // Adds imported milestones that don't already exist (matched by date+label,
  // since imported entries get a fresh id — see ImportButton). Mirrors the
  // MAX_MILESTONES cap onMilestoneAdd itself enforces, so the reported
  // "imported" count never claims more than actually got added.
  const handleImportMilestones = useCallback((imported: Milestone[]): { imported: number; skipped: number } => {
    const seenKeys = new Set(milestones.map(m => `${m.date}|${m.label}`))
    let count = milestones.length
    let addedCount = 0
    let skipped = 0
    for (const m of imported) {
      const key = `${m.date}|${m.label}`
      if (seenKeys.has(key) || count >= MAX_MILESTONES) {
        skipped += 1
        continue
      }
      seenKeys.add(key)
      count += 1
      onMilestoneAdd?.(m.label, m.date, m.emoji, m.recurring)
      addedCount += 1
    }
    return { imported: addedCount, skipped }
  }, [milestones, onMilestoneAdd])

  async function handleShareApp() {
    try {
      const result = await shareApp()
      if (result === 'copied') {
        setShareMsg(t.settings.urlCopied)
        setTimeout(() => setShareMsg(null), 2000)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e)
    }
  }

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault()
    onClose()
  }, [onClose])

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose()
  }, [onClose])

  return (
    <motion.dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <div className="settings-modal-header">
        <h3 id="settings-title">{t.settings.title}</h3>
        <button className="settings-modal-close" onClick={onClose} aria-label={t.settings.close}>×</button>
      </div>
      <nav className="settings-nav" aria-label={t.settings.navLabel}>
        {SETTINGS_SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            className={`settings-nav-item${s.className ? ` ${s.className}` : ''}${activeSection === s.id ? ' active' : ''}`}
            aria-current={activeSection === s.id ? 'true' : undefined}
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {t.settings[s.labelKey]}
          </button>
        ))}
      </nav>
      <div className="settings-list" ref={listRef}>

        {/* Account */}
        <div className="settings-section settings-section-account" id="settings-account">
          <div className="settings-account-row">
            {email && (
              <span className="settings-account-avatar" aria-hidden="true">
                {email[0].toUpperCase()}
              </span>
            )}
            <div className="settings-account-info">
              <span className="settings-item-label">{t.settings.account}</span>
              {email && <span className="settings-account-email" title={email}>{email}</span>}
            </div>
            <button className="settings-signout-btn" onClick={() => setSignOutConfirmOpen(true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              {t.app.signOut}
            </button>
          </div>
        </div>

        {/* Appearance */}
        <div className="settings-section" id="settings-appearance">
          <h4 className="settings-section-title">{t.settings.sectionAppearance}</h4>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.theme}</span>
              {appliedFlash === 'theme' && <AppliedChip />}
            </span>
            <div className="settings-theme-picker">
              <button
                type="button"
                className={`settings-theme-option ${themeMode === 'light' ? 'active' : ''}`}
                onClick={() => { flashApplied('theme'); onThemeModeChange('light') }}
                aria-label={t.settings.themeLight}
                aria-pressed={themeMode === 'light'}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4"/>
                  <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
                <span className="settings-theme-label">{t.settings.themeLight}</span>
              </button>
              <button
                type="button"
                className={`settings-theme-option ${themeMode === 'dark' ? 'active' : ''}`}
                onClick={() => { flashApplied('theme'); onThemeModeChange('dark') }}
                aria-label={t.settings.themeDark}
                aria-pressed={themeMode === 'dark'}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
                <span className="settings-theme-label">{t.settings.themeDark}</span>
              </button>
              <button
                type="button"
                className={`settings-theme-option ${themeMode === 'system' ? 'active' : ''}`}
                onClick={() => { flashApplied('theme'); onThemeModeChange('system') }}
                aria-label={t.settings.themeAuto}
                aria-pressed={themeMode === 'system'}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <span className="settings-theme-label">{t.settings.themeAuto}</span>
              </button>
            </div>
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.accentColor}</span>
              {appliedFlash === 'accent' && <AppliedChip />}
            </span>
            <div className="settings-color-picker">
              <button
                type="button"
                className={`settings-color-option ${accentColor === 'indigo' ? 'active' : ''}`}
                onClick={() => { flashApplied('accent'); onAccentChange('indigo') }}
                aria-label={t.settings.accentIndigo}
                aria-pressed={accentColor === 'indigo'}
              >
                <span className="settings-color-swatch" style={{ background: '#5c5fa8' }} />
                <span className="settings-color-label">{t.settings.accentIndigo}</span>
              </button>
              <button
                type="button"
                className={`settings-color-option ${accentColor === 'sage' ? 'active' : ''}`}
                onClick={() => { flashApplied('accent'); onAccentChange('sage') }}
                aria-label={t.settings.accentSage}
                aria-pressed={accentColor === 'sage'}
              >
                <span className="settings-color-swatch" style={{ background: '#4a6a4a' }} />
                <span className="settings-color-label">{t.settings.accentSage}</span>
              </button>
              <button
                type="button"
                className={`settings-color-option ${accentColor === 'terracotta' ? 'active' : ''}`}
                onClick={() => { flashApplied('accent'); onAccentChange('terracotta') }}
                aria-label={t.settings.accentTerracotta}
                aria-pressed={accentColor === 'terracotta'}
              >
                <span className="settings-color-swatch" style={{ background: '#a8635c' }} />
                <span className="settings-color-label">{t.settings.accentTerracotta}</span>
              </button>
            </div>
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.serifFont}</span>
              {appliedFlash === 'font' && <AppliedChip />}
            </span>
            <div className="settings-font-picker">
              <button
                type="button"
                className={`settings-font-option ${fontMode === 'sans' ? 'active' : ''}`}
                onClick={() => { if (fontMode !== 'sans') { flashApplied('font'); onFontToggle() } }}
                aria-label={t.settings.fontSans}
                aria-pressed={fontMode === 'sans'}
              >
                <span className="settings-font-sample" style={{ fontFamily: "'Inter', 'Noto Sans JP', sans-serif" }}>Aあ</span>
                <span className="settings-font-label">{t.settings.fontSans}</span>
              </button>
              <button
                type="button"
                className={`settings-font-option ${fontMode === 'serif' ? 'active' : ''}`}
                onClick={() => { if (fontMode !== 'serif') { flashApplied('font'); onFontToggle() } }}
                aria-label={t.settings.fontSerif}
                aria-pressed={fontMode === 'serif'}
              >
                <span className="settings-font-sample" style={{ fontFamily: "'Source Serif 4', 'Noto Serif JP', serif" }}>Aあ</span>
                <span className="settings-font-label">{t.settings.fontSerif}</span>
              </button>
            </div>
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.fontSize}</span>
              {appliedFlash === 'fontSize' && <AppliedChip />}
            </span>
            <SettingsSelect
              aria-label={t.settings.fontSize}
              value={fontSize}
              onChange={val => { flashApplied('fontSize'); onFontSizeChange(val as FontSize) }}
              options={[
                { value: 'sm', label: t.settings.fontSizeSm },
                { value: 'md', label: t.settings.fontSizeMd },
                { value: 'lg', label: t.settings.fontSizeLg },
                { value: 'xl', label: t.settings.fontSizeXl },
              ]}
            />
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.common.language}</span>
              {appliedFlash === 'language' && <AppliedChip />}
            </span>
            <SettingsSelect
              aria-label={t.common.language}
              value={language}
              onChange={val => { flashApplied('language'); setLanguage(val === 'en' ? 'en' : 'ja') }}
              options={[
                { value: 'ja', label: t.common.japanese },
                { value: 'en', label: t.common.english },
              ]}
            />
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.autoSave}</span>
              <InfoTip text={t.settings.autoSaveHelp} />
              {appliedFlash === 'autoSave' && <AppliedChip />}
            </span>
            <button
              className={`settings-switch ${autoSave ? 'active' : ''}`}
              onClick={() => { flashApplied('autoSave'); onAutoSaveToggle() }}
              role="switch"
              aria-checked={autoSave}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
        </div>

        {/* Calendar */}
        <div className="settings-section" id="settings-calendar">
          <h4 className="settings-section-title">{t.settings.sectionCalendar}</h4>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.holidayCountry}</span>
              <InfoTip text={t.settings.holidaysHelp} />
              {appliedFlash === 'calendar' && <AppliedChip />}
            </span>
            <SettingsSelect
              aria-label={t.settings.holidayCountry}
              value={holidayCountry}
              onChange={val => { flashApplied('calendar'); onHolidayCountryChange(isHolidayCountry(val) ? val : 'off') }}
              options={holidayOptions}
            />
          </div>
        </div>

        {/* Milestones */}
        <div className="settings-section" id="settings-milestones">
          <div className="settings-section-title-row">
            <span className="settings-item-label-group">
              <h4 className="settings-section-title">{t.settings.milestones}</h4>
              <InfoTip text={t.settings.milestonesHelp} />
            </span>
            <span className="settings-milestone-title-actions">
              <span className="settings-milestone-usage">
                {t.settings.milestoneUsage(milestones.length, MAX_MILESTONES)}
              </span>
              {onMilestoneAdd && (
                <button
                  type="button"
                  className="settings-milestone-add-btn"
                  onClick={() => setMilestoneModal({ mode: 'add' })}
                  disabled={milestoneLimitReached}
                  aria-describedby={milestoneLimitReached ? milestoneLimitId : undefined}
                >
                  {t.settings.milestoneAdd}
                </button>
              )}
            </span>
          </div>
          <div className="settings-item settings-item-milestones">
            <div className="settings-milestone-section">
              <div className="settings-milestone-help">
                <span id={milestoneLimitId} className="settings-milestone-limit">
                  {t.settings.milestoneRegistrationLimit(MAX_MILESTONES)}
                </span>
                <span id={badgeLimitId} className="settings-milestone-limit">
                  {t.settings.milestoneBadgeLimit(MAX_MILESTONE_BADGES)}
                </span>
              </div>
              {milestones.length === 0 ? (
                <span className="settings-milestone-none">{t.settings.milestoneNone}</span>
              ) : (
                <>
                  <button
                    type="button"
                    className="settings-milestone-toggle"
                    onClick={() => setListExpanded(v => !v)}
                    aria-expanded={listExpanded}
                  >
                    <span className={`settings-milestone-toggle-chevron${listExpanded ? ' open' : ''}`} aria-hidden="true">▸</span>
                    {listExpanded ? t.settings.milestonHideList : t.settings.milestoneShowList}
                  </button>
                <AnimatePresence initial={false}>
                {listExpanded && (
                  <motion.div
                    key="list"
                    className="settings-milestone-list"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ overflowY: 'clip', overflowX: 'visible' }}
                  >
                  <AnimatePresence initial={false} mode="popLayout">
                    {milestones.map(a => {
                      const badgeEnabled = a.showBadge !== false
                      const badgeLimitReached = !badgeEnabled && enabledBadgeCount >= MAX_MILESTONE_BADGES
                      return (
                        <motion.div
                          key={a.id}
                          layout
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.18 }}
                        >
                          <div className="settings-milestone-row">
                            <div className="settings-milestone-details">
                              <span className="settings-milestone-label">
                                <span className="settings-milestone-emoji">{a.emoji || '🎀'}</span>
                                {a.label}
                                {a.recurring !== false && <span className="settings-milestone-recurring-tag">{t.settings.milestoneRecurring}</span>}
                              </span>
                              <time className="settings-milestone-date" dateTime={a.date}>{a.date}</time>
                            </div>
                            <div className="settings-milestone-actions">
                              {onMilestoneToggleBadge && (
                                <span className="settings-milestone-badge-toggle-wrap">
                                  <button
                                    type="button"
                                    className={`settings-milestone-badge-toggle${badgeEnabled ? ' active' : ''}`}
                                    onClick={() => {
                                      if (!badgeLimitReached) onMilestoneToggleBadge(a.id)
                                    }}
                                    role="switch"
                                    aria-checked={badgeEnabled}
                                    aria-disabled={badgeLimitReached || undefined}
                                    aria-describedby={badgeLimitReached ? badgeLimitId : undefined}
                                    aria-label={t.settings.milestoneBadgeLabel}
                                  >
                                    <span className="settings-milestone-badge-toggle-thumb" />
                                  </button>
                                  <span className="settings-milestone-badge-label">
                                    {t.settings.milestoneBadgeLabel}
                                    <InfoTip text={t.settings.milestoneBadgeHelp} />
                                  </span>
                                </span>
                              )}
                              {onMilestoneUpdate && (
                                <button
                                  type="button"
                                  className="settings-milestone-edit"
                                  onClick={() => { setPendingDelete(null); setMilestoneModal({ mode: 'edit', milestone: a }) }}
                                  aria-label={t.settings.milestoneEdit(a.label)}
                                >✎</button>
                              )}
                              {onMilestoneRemove && (
                                <AnimatePresence mode="wait" initial={false}>
                                  {pendingDelete?.id === a.id ? (
                                    <motion.span
                                      key="confirm"
                                      className="settings-milestone-confirm"
                                      initial={{ opacity: 0, x: 8 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      exit={{ opacity: 0, x: 8 }}
                                      transition={{ duration: 0.15 }}
                                    >
                                      <span className="settings-milestone-confirm-text">{t.settings.milestoneDeleteConfirm(a.label)}</span>
                                      <span className="settings-milestone-confirm-actions">
                                        <button type="button" className="settings-milestone-confirm-yes" onClick={() => { onMilestoneRemove(a.id); setPendingDelete(null) }}>{t.settings.milestoneDeleteYes}</button>
                                        <button type="button" className="settings-milestone-confirm-no" onClick={() => setPendingDelete(null)}>{t.settings.milestoneDeleteNo}</button>
                                      </span>
                                    </motion.span>
                                  ) : (
                                    <motion.button
                                      key="remove"
                                      type="button"
                                      className="settings-milestone-remove"
                                      onClick={() => { setPendingDelete(a) }}
                                      aria-label={t.settings.milestoneRemove(a.label)}
                                      initial={{ opacity: 0 }}
                                      animate={{ opacity: 1 }}
                                      exit={{ opacity: 0 }}
                                      transition={{ duration: 0.12 }}
                                    >×</motion.button>
                                  )}
                                </AnimatePresence>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                  </motion.div>
                )}
                </AnimatePresence>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Data */}
        <div className="settings-section" id="settings-data">
          <h4 className="settings-section-title">{t.settings.sectionData}</h4>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.exportAllEntries}</span>
              <InfoTip text={t.settings.exportHelp} />
            </span>
            <ExportButton dates={dates} onExport={onExport} />
          </div>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.importAllEntries}</span>
              <InfoTip text={t.settings.importHelp} />
            </span>
            <ImportButton
              existingDates={dates}
              onImport={onImport}
              existingMilestones={milestones}
              onImportMilestones={onMilestoneAdd ? handleImportMilestones : undefined}
            />
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.shareThisApp} <InfoTip text={t.settings.shareHelp} /></span>
            <button className="settings-action-btn" onClick={handleShareApp}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              {shareMsg ?? t.settings.share}
            </button>
          </div>
        </div>

        {/* S3 backup (advanced) */}
        <div className="settings-section" id="settings-backup">
          <h4 className="settings-section-title">{t.settings.sectionS3}</h4>
          
          <div className="settings-s3-group-title">
            <span className="settings-s3-group-title-label">{t.settings.s3GroupSetup}</span>
            <button
              type="button"
              className="settings-s3-toggle"
              onClick={() => { s3SetupTouched.current = true; setS3SetupOpen(v => !v) }}
              aria-expanded={s3SetupOpen}
            >
              <span className={`settings-milestone-toggle-chevron${s3SetupOpen ? ' open' : ''}`} aria-hidden="true">▸</span>
              {s3SetupOpen ? t.settings.s3Collapse : t.settings.s3Expand}
            </button>
          </div>
          <motion.div
            className="settings-s3-setup"
            initial={false}
            animate={{ opacity: s3SetupOpen ? 1 : 0, height: s3SetupOpen ? 'auto' : 0 }}
            transition={{ duration: 0.18 }}
            style={{ overflowY: 'clip', overflowX: 'visible' }}
          >
          <p className="settings-about-text settings-s3-help">
            {t.settings.s3Help}
          </p>
          <ol className="settings-about-list settings-s3-help">
            {t.settings.s3Steps.map((step, i) => <li key={i}>{step}</li>)}
          </ol>

          <div className="settings-item">
            <span className="settings-item-label">{t.settings.s3Bucket}</span>
            <input
              type="text"
              className="settings-text-input"
              value={s3Bucket}
              onChange={handleS3FieldChange(setS3Bucket)}
              placeholder={t.settings.s3BucketPlaceholder}
              spellCheck={false}
            />
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.s3Region}</span>
            <input
              type="text"
              className="settings-text-input"
              value={s3Region}
              onChange={handleS3FieldChange(setS3Region)}
              placeholder={t.settings.s3RegionPlaceholder}
              spellCheck={false}
            />
          </div>

          {googleClientId && (
            <div className="settings-item settings-item-copy">
              <span className="settings-item-label-group">
                <span className="settings-item-label">{t.settings.s3LingerClientId}</span>
                <InfoTip text={t.settings.s3LingerClientIdHelp} />
              </span>
              <div className="settings-copy-row">
                <code className="settings-copy-value" title={googleClientId}>{googleClientId}</code>
                <button
                  type="button"
                  className="settings-copy-btn"
                  onClick={() => handleCopy('clientId', googleClientId)}
                >
                  {copiedField === 'clientId' ? (
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                  {copiedField === 'clientId' ? t.settings.s3Copied : t.settings.s3Copy}
                </button>
              </div>
            </div>
          )}
          {googleSub && (
            <div className="settings-item settings-item-copy">
              <span className="settings-item-label-group">
                <span className="settings-item-label">{t.settings.s3GoogleAccountId}</span>
                <InfoTip text={t.settings.s3GoogleAccountIdHelp} />
              </span>
              <div className="settings-copy-row">
                <code className="settings-copy-value" title={googleSub}>{googleSub}</code>
                <button
                  type="button"
                  className="settings-copy-btn"
                  onClick={() => handleCopy('sub', googleSub)}
                >
                  {copiedField === 'sub' ? (
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                  {copiedField === 'sub' ? t.settings.s3Copied : t.settings.s3Copy}
                </button>
              </div>
            </div>
          )}

          <p className="settings-about-text settings-s3-help settings-s3-help-links">
            <a
              href="/self-hosted-s3"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.settings.s3SetupGuide} ↗
            </a>
            <span className="settings-s3-link-separator" aria-hidden="true">|</span>
            <button
              type="button"
              className="settings-tfvars-download-btn"
              onClick={handleDownloadTfvars}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {t.settings.s3DownloadTfvars}
            </button>
          </p>
          </motion.div>

          <div className="settings-s3-group-title">{t.settings.s3GroupConnection}</div>
          
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.s3RoleArn}</span>
            <input
              type="text"
              className="settings-text-input"
              value={s3RoleArn}
              onChange={handleS3FieldChange(setS3RoleArn)}
              placeholder={t.settings.s3RoleArnPlaceholder}
              spellCheck={false}
            />
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.s3Enabled}</span>
            <input
              type="checkbox"
              checked={s3Enabled}
              onChange={handleS3EnabledChange}
              aria-label={t.settings.s3Enabled}
            />
          </div>
          <p className="settings-about-text settings-s3-help settings-s3-actions-help">
            {t.settings.s3ActionsHelp}
          </p>
          <div className="settings-item">
            <span className="settings-item-label" />
            <div className="settings-s3-actions">
              <button
                type="button"
                className={`settings-action-btn settings-action-btn--secondary${s3TestState === 'testing' ? ' btn-saving' : ''}`}
                onClick={handleS3Test}
                disabled={s3SyncBusy}
                aria-busy={s3TestState === 'testing'}
                title={(s3TestState !== 'testing' && s3SyncBusy) ? t.settings.s3ActionDisabledByOp(s3BusyOpLabel ?? t.settings.s3OpSave) : undefined}
              >
                {s3TestState === 'testing' && <SpinnerIcon />}
                {s3TestState === 'testing' ? t.settings.s3Testing : s3TestState === 'ok' ? t.settings.s3TestOk : t.settings.s3Test}
              </button>
              <button
                type="button"
                className={`settings-action-btn${(s3SaveState === 'saving' || s3Prechecking) ? ' btn-saving' : ''}`}
                onClick={() => { void handleS3SaveClick() }}
                disabled={s3SyncBusy}
                aria-busy={s3SaveState === 'saving' || s3Prechecking}
                title={(s3Resyncing || s3Retrying || s3BackfillActive || s3TestState === 'testing') ? t.settings.s3ActionDisabledByOp(s3BusyOpLabel ?? t.settings.s3OpSave) : undefined}
              >
                {(s3SaveState === 'saving' || s3Prechecking) && <SpinnerIcon />}
                {s3Prechecking ? t.settings.s3Checking : s3SaveState === 'saved' ? t.settings.s3Saved : s3SaveLabel}
              </button>
              {s3InitiallyEnabled && (
                <button
                  type="button"
                  className={`settings-action-btn settings-action-btn--secondary${(s3Resyncing || s3BackfillActive) ? ' btn-saving' : ''}`}
                  onClick={() => { void handleS3Resync() }}
                  disabled={s3SyncBusy}
                  aria-busy={s3Resyncing || s3BackfillActive}
                  title={(!s3Resyncing && !s3BackfillActive && s3SyncBusy) ? t.settings.s3ActionDisabledByOp(s3BusyOpLabel ?? t.settings.s3OpSave) : undefined}
                >
                  {(s3Resyncing || s3BackfillActive) && <SpinnerIcon />}
                  {s3Resyncing || s3BackfillActive ? t.settings.s3Resyncing : t.settings.s3Resync}
                </button>
              )}
            </div>
          </div>
          {s3InitiallyEnabled && (
            <p className="settings-about-text settings-s3-help settings-s3-actions-help">
              {t.settings.s3ResyncHelp}
            </p>
          )}
          {s3InitiallyEnabled && (
            <>
              <div className="settings-s3-group-title">{t.settings.s3GroupRestore}</div>
              <p className="settings-about-text settings-s3-help">
                {t.settings.s3RestoreHelp}
              </p>
              {!s3RestoreLoading && s3RestoreCandidates && s3RestoreCandidates.length === 0 && (
                <p className="settings-about-text settings-s3-help">{t.settings.s3RestoreNone}</p>
              )}
              {!s3RestoreLoading && s3RestoreCandidates && s3RestoreCandidates.length > 0 && (
                <ul className="export-format-tree s3-overwrite-confirm-list">
                  {s3RestoreCandidates.slice(0, 50).map(date => (
                    <li key={date} className="export-format-file settings-s3-restore-row">
                      <span className="settings-s3-restore-date">{date}</span>
                      <button
                        type="button"
                        className={`settings-action-btn settings-action-btn--secondary${s3RestoringDate === date ? ' btn-saving' : ''}`}
                        onClick={() => { void handleS3Restore(date) }}
                        disabled={s3RestoringDate !== null}
                        aria-busy={s3RestoringDate === date}
                      >
                        {s3RestoringDate === date && <SpinnerIcon />}
                        {s3RestoringDate === date ? t.settings.s3Restoring : t.settings.s3Restore}
                      </button>
                    </li>
                  ))}
                  {s3RestoreCandidates.length > 50 && (
                    <li className="export-format-file">{t.settings.s3BackfillFailedMore(s3RestoreCandidates.length - 50)}</li>
                  )}
                </ul>
              )}
              {s3RestoreError && (
                <p className="settings-item-error"><ErrorIcon />{t.settings.s3RestoreFailed}: {s3RestoreError}</p>
              )}
            </>
          )}
          <div aria-live="polite">
            {s3TestState === 'ok' && <p className="settings-item-success"><CheckIcon />{t.settings.s3TestOkMsg}</p>}
            {s3TestState === 'ok' && s3TestCollisions && s3TestCollisions.length > 0 && (
              <div className="settings-backfill-failed">
                <p className="settings-item-error">{t.settings.s3OverwriteConfirmDesc(s3TestCollisions.length)}</p>
                <ul className="export-format-tree s3-overwrite-confirm-list">
                  {s3TestCollisions.slice(0, 20).map(key => <li key={key} className="export-format-file">{key}</li>)}
                  {s3TestCollisions.length > 20 && (
                    <li className="export-format-file">{t.settings.s3OverwriteConfirmMore(s3TestCollisions.length - 20)}</li>
                  )}
                </ul>
              </div>
            )}
            {s3TestState === 'error' && (
              <p className="settings-item-error"><ErrorIcon />{t.settings.s3TestFailed}{s3TestError ? `: ${s3TestError}` : ''}</p>
            )}
            {s3TestState === 'invalid' && <p className="settings-item-error"><ErrorIcon />{s3TestError}</p>}
            {s3SaveState === 'saved' && <p className="settings-item-success"><CheckIcon />{t.settings.s3SaveSuccess}</p>}
            {s3SaveState === 'error' && <p className="settings-item-error"><ErrorIcon />{t.settings.s3SaveError}</p>}
          </div>
          {s3Enabled && s3BackfillProgress && !s3BackfillProgress.finishedAt && (
            <div className="settings-backfill-progress" aria-live="polite">
              <p className="settings-about-text settings-s3-help">
                {t.settings.s3BackfillInProgress(s3BackfillProgress.done, s3BackfillProgress.total)}
              </p>
              <progress
                className="settings-backfill-progress-bar"
                value={s3BackfillProgress.done}
                max={Math.max(s3BackfillProgress.total, 1)}
              />
            </div>
          )}
          {s3Enabled && s3BackfillProgress?.finishedAt && s3BackfillProgress.failed.length > 0 && (
            <div className="settings-backfill-failed">
              <p className="settings-item-error">{t.settings.s3BackfillFailedSummary(s3BackfillProgress.failed.length)}</p>
              <ul className="export-format-tree s3-overwrite-confirm-list">
                {s3BackfillProgress.failed.slice(0, 20).map(date => <li key={date} className="export-format-file">{date}</li>)}
                {s3BackfillProgress.failed.length > 20 && (
                  <li className="export-format-file">{t.settings.s3BackfillFailedMore(s3BackfillProgress.failed.length - 20)}</li>
                )}
              </ul>
              <button
                type="button"
                className={`settings-action-btn settings-action-btn--secondary${s3Retrying ? ' btn-saving' : ''}`}
                onClick={() => { void handleS3RetryBackfill() }}
                disabled={s3SyncBusy}
                aria-busy={s3Retrying}
                title={(!s3Retrying && s3SyncBusy) ? t.settings.s3ActionDisabledByOp(s3BusyOpLabel ?? t.settings.s3OpSave) : undefined}
              >
                {s3Retrying && <SpinnerIcon />}
                {s3Retrying ? t.settings.s3BackfillRetrying : t.settings.s3BackfillRetry}
              </button>
            </div>
          )}
          {s3Enabled && s3LastSyncError && !(s3BackfillProgress && s3BackfillProgress.failed.length > 0) && (
            <p className="settings-item-error">
              {t.settings.s3SyncError}: {s3LastSyncError}
              {s3LastSyncErrorAt ? ` (${new Date(s3LastSyncErrorAt).toLocaleString()})` : ''}
            </p>
          )}
        </div>

        <div className="settings-legal">
          <a href="/privacy" target="_blank" rel="noopener noreferrer">{t.settings.privacyPolicy}</a>
          {' · '}
          <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">{t.settings.termsOfService}</a>
          {' · '}
          <a href="https://github.com/europeanplaice/linger" target="_blank" rel="noopener noreferrer">{t.settings.github}</a>
        </div>
      </div>

      {milestoneModal && (
        <MilestoneFormModal
          mode={milestoneModal.mode}
          milestone={milestoneModal.milestone}
          onSave={(label, date, emoji, recurring) => {
            if (milestoneModal.mode === 'add') {
              onMilestoneAdd?.(label, date, emoji, recurring)
            } else {
              onMilestoneUpdate?.(milestoneModal.milestone!.id, label, date, emoji, recurring)
            }
            setMilestoneModal(null)
          }}
          onClose={() => setMilestoneModal(null)}
          t={t}
        />
      )}

      <dialog
        ref={signOutDialogRef}
        className="signout-confirm-dialog"
        aria-labelledby="signout-confirm-title"
        onCancel={(e) => { e.preventDefault(); setSignOutConfirmOpen(false) }}
        onClick={(e) => { if (e.target === signOutDialogRef.current) setSignOutConfirmOpen(false) }}
      >
        <h4 id="signout-confirm-title" className="signout-confirm-title">{t.app.signOutConfirmTitle}</h4>
        <p className="signout-confirm-desc">{t.app.signOutConfirmDesc}</p>
        <div className="signout-confirm-actions">
          <button className="signout-confirm-cancel" onClick={() => setSignOutConfirmOpen(false)}>{t.common.cancel}</button>
          <button className="signout-confirm-start" onClick={() => { setSignOutConfirmOpen(false); onSignOut() }}>{t.app.signOut}</button>
        </div>
      </dialog>

      <dialog
        ref={s3OverwriteDialogRef}
        className="signout-confirm-dialog s3-overwrite-confirm-dialog"
        aria-labelledby="s3-overwrite-confirm-title"
        onCancel={(e) => { e.preventDefault(); setS3OverwriteConfirmOpen(false) }}
        onClick={(e) => { if (e.target === s3OverwriteDialogRef.current) setS3OverwriteConfirmOpen(false) }}
      >
        <h4 id="s3-overwrite-confirm-title" className="signout-confirm-title">{t.settings.s3OverwriteConfirmTitle}</h4>
        <p className="signout-confirm-desc">{t.settings.s3OverwriteConfirmDesc(s3Collisions.length)}</p>
        <ul className="export-format-tree s3-overwrite-confirm-list">
          {s3Collisions.slice(0, 20).map(key => <li key={key} className="export-format-file">{key}</li>)}
          {s3Collisions.length > 20 && (
            <li className="export-format-file">{t.settings.s3OverwriteConfirmMore(s3Collisions.length - 20)}</li>
          )}
        </ul>
        <div className="signout-confirm-actions">
          <button className="signout-confirm-cancel" onClick={() => setS3OverwriteConfirmOpen(false)}>{t.common.cancel}</button>
          <button
            className="signout-confirm-start"
            onClick={() => { setS3OverwriteConfirmOpen(false); void handleS3Save() }}
          >
            {t.settings.s3OverwriteConfirmProceed}
          </button>
        </div>
      </dialog>
    </motion.dialog>
  )
}


