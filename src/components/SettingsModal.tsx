import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CalendarDays } from 'lucide-react'
import { ExportButton } from './ExportButton'
import { SettingsSelect } from './SettingsSelect'
import { CalendarView } from './CalendarView'
import { EmojiPicker } from './EmojiPicker'
import { shareApp } from '../utils/share'
import { useI18n } from '../i18n'
import type { ThemeMode } from '../hooks/useTheme'
import type { FontSize } from '../hooks/useFontSize'
import type { HolidayCountry } from '../utils/holidays'
import { HOLIDAY_COUNTRY_CODES, isHolidayCountry } from '../utils/holidays'

import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  MAX_MILESTONE_LABEL_LENGTH,
  type Milestone,
} from '../types'


interface SettingsModalProps {
  autoSave: boolean
  onAutoSaveToggle: () => void
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  fontMode: 'serif' | 'sans'
  onFontToggle: () => void
  fontSize: FontSize
  onFontSizeChange: (size: FontSize) => void
  holidayCountry: HolidayCountry
  onHolidayCountryChange: (country: HolidayCountry) => void
  dates: string[]
  onExport: (onProgress: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
  onClose: () => void
  onSignOut: () => void
  email?: string
  milestones?: Milestone[]
  onMilestoneAdd?: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneUpdate?: (id: string, label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneRemove?: (id: string) => void
  onMilestoneToggleBadge?: (id: string) => void
}

const calendarAnchorSupported = typeof CSS !== 'undefined' && CSS.supports('anchor-name', '--x')

export function SettingsModal({ autoSave, onAutoSaveToggle, themeMode, onThemeModeChange, fontMode, onFontToggle, fontSize, onFontSizeChange, holidayCountry, onHolidayCountryChange, dates, onExport, onClose, onSignOut, email, milestones = [], onMilestoneAdd, onMilestoneUpdate, onMilestoneRemove, onMilestoneToggleBadge }: SettingsModalProps) {
  const { t, locale, language, setLanguage } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<Milestone | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [listExpanded, setListExpanded] = useState(false)
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
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false)

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
      <div className="settings-list">
        <div className="settings-item settings-account-item">
          <div className="settings-account-info">
            <span className="settings-item-label">{t.settings.account}</span>
            {email && <span className="settings-account-email" title={email}>{email}</span>}
          </div>
          <button className="settings-action-btn settings-signout-btn" onClick={() => setSignOutConfirmOpen(true)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            {t.app.signOut}
          </button>
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.common.language}</span>
          <SettingsSelect
            aria-label={t.common.language}
            value={language}
            onChange={val => setLanguage(val === 'en' ? 'en' : 'ja')}
            options={[
              { value: 'ja', label: t.common.japanese },
              { value: 'en', label: t.common.english },
            ]}
          />
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.holidayCountry}</span>
          <SettingsSelect
            aria-label={t.settings.holidayCountry}
            value={holidayCountry}
            onChange={val => onHolidayCountryChange(isHolidayCountry(val) ? val : 'off')}
            options={holidayOptions}
          />
        </div>
        <div className="settings-divider" />
        <div className="settings-item settings-item-milestones">
          <div className="settings-milestone-heading">
            <span className="settings-item-label">{t.settings.milestones}</span>
            <span className="settings-milestone-usage">
              {t.settings.milestoneUsage(milestones.length, MAX_MILESTONES)}
            </span>
          </div>
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
                  style={{ overflow: 'hidden' }}
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
                        <AnimatePresence mode="wait" initial={false}>
                          {editingId === a.id && onMilestoneUpdate ? (
                            <motion.div
                              key="edit"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.12 }}
                            >
                              <MilestoneEditForm
                                milestone={a}
                                onSave={(label, date, emoji, recurring) => {
                                  onMilestoneUpdate(a.id, label, date, emoji, recurring)
                                  setEditingId(null)
                                }}
                                onCancel={() => setEditingId(null)}
                                t={t}
                              />
                            </motion.div>
                          ) : (
                            <motion.div
                              key="display"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.12 }}
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
                                      <span className="settings-milestone-badge-label">{t.settings.milestoneBadgeLabel}</span>
                                    </span>
                                  )}
                                  {onMilestoneUpdate && (
                                    <button
                                      type="button"
                                      className="settings-milestone-edit"
                                      onClick={() => { setPendingDelete(null); setEditingId(a.id) }}
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
                                          onClick={() => { setEditingId(null); setPendingDelete(a) }}
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
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
                </motion.div>
              )}
              </AnimatePresence>
              </>
            )}
            {onMilestoneAdd && (
              <MilestoneAddForm
                onAdd={onMilestoneAdd}
                t={t}
                limitReached={milestoneLimitReached}
                limitDescriptionId={milestoneLimitId}
              />
            )}
          </div>
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.theme}</span>
          <div className="settings-theme-picker">
            <button
              type="button"
              className={`settings-theme-option ${themeMode === 'light' ? 'active' : ''}`}
              onClick={() => onThemeModeChange('light')}
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
              onClick={() => onThemeModeChange('dark')}
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
              onClick={() => onThemeModeChange('system')}
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
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.serifFont}</span>
          <div className="settings-font-picker">
            <button
              type="button"
              className={`settings-font-option ${fontMode === 'sans' ? 'active' : ''}`}
              onClick={() => { if (fontMode !== 'sans') onFontToggle() }}
              aria-label={t.settings.fontSans}
              aria-pressed={fontMode === 'sans'}
            >
              <span className="settings-font-sample" style={{ fontFamily: "'Inter', 'Noto Sans JP', sans-serif" }}>Aあ</span>
              <span className="settings-font-label">{t.settings.fontSans}</span>
            </button>
            <button
              type="button"
              className={`settings-font-option ${fontMode === 'serif' ? 'active' : ''}`}
              onClick={() => { if (fontMode !== 'serif') onFontToggle() }}
              aria-label={t.settings.fontSerif}
              aria-pressed={fontMode === 'serif'}
            >
              <span className="settings-font-sample" style={{ fontFamily: "'Source Serif 4', 'Noto Serif JP', serif" }}>Aあ</span>
              <span className="settings-font-label">{t.settings.fontSerif}</span>
            </button>
          </div>
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.fontSize}</span>
          <SettingsSelect
            aria-label={t.settings.fontSize}
            value={fontSize}
            onChange={val => onFontSizeChange(val as FontSize)}
            options={[
              { value: 'sm', label: t.settings.fontSizeSm },
              { value: 'md', label: t.settings.fontSizeMd },
              { value: 'lg', label: t.settings.fontSizeLg },
              { value: 'xl', label: t.settings.fontSizeXl },
            ]}
          />
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.autoSave}</span>
          <button
            className={`settings-switch ${autoSave ? 'active' : ''}`}
            onClick={onAutoSaveToggle}
            role="switch"
            aria-checked={autoSave}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.exportAllEntries}</span>
          <ExportButton dates={dates} onExport={onExport} />
        </div>
        <div className="settings-divider" />
        <div className="settings-item">
          <span className="settings-item-label">{t.settings.shareThisApp}</span>
          <button className="settings-action-btn" onClick={handleShareApp}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            {shareMsg ?? t.settings.share}
          </button>
        </div>
        <div className="settings-divider settings-shortcuts-section" />
        <div className="settings-about settings-shortcuts-section">
          <p className="settings-about-title">{t.settings.keyboardShortcuts}</p>
          <div className="settings-shortcuts">
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.saveEntry}</span>
              <span className="settings-shortcut-keys"><kbd>Ctrl</kbd><span>+</span><kbd>S</kbd></span>
            </div>
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.previousNextDay}</span>
              <span className="settings-shortcut-keys"><kbd>Alt</kbd><span>+</span><kbd>←</kbd><span>/</span><kbd>→</kbd></span>
            </div>
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.goToToday}</span>
              <span className="settings-shortcut-keys"><kbd>Alt</kbd><span>+</span><kbd>↑</kbd></span>
            </div>
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.toggleDarkTheme}</span>
              <span className="settings-shortcut-keys"><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>D</kbd></span>
            </div>
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.toggleSerifFont}</span>
              <span className="settings-shortcut-keys"><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>F</kbd></span>
            </div>
            <div className="settings-shortcut-row">
              <span className="settings-shortcut-desc">{t.settings.focusSearch}</span>
              <span className="settings-shortcut-keys"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></span>
            </div>
          </div>
        </div>
        <div className="settings-divider" />
        <div className="settings-about">
          <p className="settings-about-title">{t.settings.aboutDataStorage}</p>
          <p className="settings-about-text">
            {t.settings.storageIntro}
          </p>
          <ul className="settings-about-list">
            {t.settings.storageItems.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
          <a
            href={`https://drive.google.com/drive/search?q=linger_diary${email ? `&authuser=${encodeURIComponent(email)}` : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-drive-link"
          >
            {t.settings.viewInDrive} ↗
          </a>
        </div>
        <div className="settings-divider" />
        <div className="settings-legal">
          <a href="/privacy" target="_blank" rel="noopener noreferrer">{t.settings.privacyPolicy}</a>
          {' · '}
          <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">{t.settings.termsOfService}</a>
          {' · '}
          <a href="https://github.com/europeanplaice/linger" target="_blank" rel="noopener noreferrer">{t.settings.github}</a>
        </div>
      </div>

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
    </motion.dialog>
  )
}

function MilestoneDatePicker({ id, value, onChange, label }: {
  id: string
  value: string
  onChange: (value: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const uid = useId().replace(/[^a-z0-9]/gi, '-').replace(/^-|-$/g, '')

  const close = useCallback((restoreFocus = true) => {
    if ('hidePopover' in HTMLElement.prototype) popoverRef.current?.hidePopover()
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  const show = useCallback(() => {
    const popover = popoverRef.current
    const trigger = triggerRef.current
    if (!popover) return

    if (!calendarAnchorSupported && trigger) {
      const rect = trigger.getBoundingClientRect()
      popover.style.top = `${rect.bottom + 6}px`
      popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`
    }
    if ('showPopover' in HTMLElement.prototype) popover.showPopover()
    setOpen(true)
    requestAnimationFrame(() => {
      const selected = popover.querySelector<HTMLButtonElement>('.cal-day.selected')
      const today = popover.querySelector<HTMLButtonElement>('.cal-day.today')
      ;(selected ?? today)?.focus()
    })
  }, [])

  useEffect(() => {
    if (!calendarAnchorSupported) return
    const name = `--milestone-calendar-${uid}`
    triggerRef.current?.style.setProperty('anchor-name', name)
    popoverRef.current?.style.setProperty('position-anchor', name)
  }, [uid])

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent) => {
      if (
        !triggerRef.current?.contains(event.target as Node)
        && !popoverRef.current?.contains(event.target as Node)
      ) {
        close(false)
      }
    }
    document.addEventListener('mousedown', handlePointer)
    return () => document.removeEventListener('mousedown', handlePointer)
  }, [close, open])

  const toggle = () => {
    if (open) close()
    else show()
  }

  return (
    <div className="settings-milestone-date-picker">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`settings-milestone-input settings-milestone-date-input${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required="true"
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      >
        <span className={value ? '' : 'settings-milestone-date-placeholder'}>
          {value || label}
        </span>
        <CalendarDays size={16} aria-hidden="true" />
      </button>
      <input type="hidden" name="milestone-date" value={value} />
      <div
        ref={popoverRef}
        popover="manual"
        className="settings-milestone-date-popover"
        role="dialog"
        aria-label={label}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      >
        <CalendarView
          dates={new Set()}
          selectedDate={value}
          onSelect={date => {
            onChange(date)
            close()
          }}
        />
      </div>
    </div>
  )
}

function validateMilestoneFields(
  label: string,
  date: string,
  t: ReturnType<typeof useI18n>['t'],
): string[] {
  const errs: string[] = []
  if (!label.trim()) errs.push(t.settings.milestoneEmptyLabel)
  if (label.trim().length > MAX_MILESTONE_LABEL_LENGTH) errs.push(t.settings.milestoneLabelTooLong(MAX_MILESTONE_LABEL_LENGTH))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errs.push(t.settings.milestoneInvalidDate)
  } else {
    const [y, m, d] = date.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
      errs.push(t.settings.milestoneInvalidDate)
    }
  }
  return errs
}

function MilestoneEditForm({ milestone, onSave, onCancel, t }: {
  milestone: Milestone
  onSave: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  onCancel: () => void
  t: ReturnType<typeof useI18n>['t']
}) {
  const labelId = useId()
  const dateId = useId()
  const [label, setLabel] = useState(milestone.label)
  const [date, setDate] = useState(milestone.date)
  const [emoji, setEmoji] = useState(milestone.emoji ?? '')
  const [recurring, setRecurring] = useState(milestone.recurring ?? true)
  const [errors, setErrors] = useState<string[]>([])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const errs = validateMilestoneFields(label, date, t)
    setErrors(errs)
    if (errs.length > 0) return
    onSave(label.trim(), date, emoji || undefined, recurring)
  }

  return (
    <form
      className="settings-milestone-form settings-milestone-edit-form"
      onSubmit={handleSubmit}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <label className="sr-only" htmlFor={labelId}>{t.settings.milestoneLabelPlaceholder}</label>
      <input
        id={labelId}
        name="milestone-label"
        className="settings-milestone-input"
        value={label}
        onChange={e => setLabel(e.target.value)}
        placeholder={t.settings.milestoneLabelPlaceholder}
        maxLength={MAX_MILESTONE_LABEL_LENGTH}
        required
        autoFocus
      />
      <label className="sr-only" htmlFor={dateId}>{t.settings.milestoneDatePlaceholder}</label>
      <MilestoneDatePicker
        id={dateId}
        value={date}
        onChange={setDate}
        label={t.settings.milestoneDatePlaceholder}
      />
      <div className="settings-milestone-extras">
        <div className="settings-milestone-emoji-picker">
          <span className="settings-milestone-emoji-label">{t.settings.milestoneEmoji}</span>
          <EmojiPicker
            value={emoji}
            onChange={setEmoji}
            searchPlaceholder={t.settings.milestoneEmojiSearch}
            triggerLabel={t.settings.milestoneEmoji}
          />
        </div>
        <div className="settings-milestone-recurring-toggle">
          <button
            type="button"
            className={`settings-milestone-type-btn${recurring ? ' active' : ''}`}
            onClick={() => setRecurring(true)}
            aria-pressed={recurring}
          >{t.settings.milestoneRecurring}</button>
          <button
            type="button"
            className={`settings-milestone-type-btn${!recurring ? ' active' : ''}`}
            onClick={() => setRecurring(false)}
            aria-pressed={!recurring}
          >{t.settings.milestoneOneTime}</button>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="settings-milestone-errors" role="alert">
          {errors.map((e, i) => <span key={i} className="settings-milestone-error">{e}</span>)}
        </div>
      )}
      <div className="settings-milestone-form-actions">
        <button type="submit" className="settings-milestone-save">{t.settings.milestoneEditSave}</button>
        <button type="button" className="settings-milestone-cancel" onClick={onCancel}>{t.settings.milestoneCancel}</button>
      </div>
    </form>
  )
}

function MilestoneAddForm({ onAdd, t, limitReached, limitDescriptionId }: {
  onAdd: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  t: ReturnType<typeof useI18n>['t']
  limitReached: boolean
  limitDescriptionId: string
}) {
  const labelId = useId()
  const dateId = useId()
  const [showForm, setShowForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newEmoji, setNewEmoji] = useState('')
  const [newRecurring, setNewRecurring] = useState(true)
  const [errors, setErrors] = useState<string[]>([])

  const openForm = () => {
    setShowForm(true)
    setNewLabel('')
    setNewDate('')
    setNewEmoji('')
    setNewRecurring(true)
    setErrors([])
  }

  const closeForm = () => {
    setShowForm(false)
    setErrors([])
  }

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault()
    const errs = validateMilestoneFields(newLabel, newDate, t)
    setErrors(errs)
    if (errs.length > 0) return
    onAdd(newLabel.trim(), newDate, newEmoji || undefined, newRecurring)
    closeForm()
  }

  return (
    <AnimatePresence mode="wait">
      {!showForm ? (
        <motion.button
          key="add-btn"
          type="button"
          className="settings-milestone-add-btn"
          onClick={openForm}
          disabled={limitReached}
          aria-describedby={limitReached ? limitDescriptionId : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          {t.settings.milestoneAdd}
        </motion.button>
      ) : (
        <motion.form
          key="add-form"
          className="settings-milestone-form"
          onSubmit={handleAdd}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <label className="sr-only" htmlFor={labelId}>{t.settings.milestoneLabelPlaceholder}</label>
          <input
            id={labelId}
            name="milestone-label"
            className="settings-milestone-input"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder={t.settings.milestoneLabelPlaceholder}
            maxLength={MAX_MILESTONE_LABEL_LENGTH}
            required
            autoFocus
          />
          <label className="sr-only" htmlFor={dateId}>{t.settings.milestoneDatePlaceholder}</label>
          <MilestoneDatePicker
            id={dateId}
            value={newDate}
            onChange={setNewDate}
            label={t.settings.milestoneDatePlaceholder}
          />
          <div className="settings-milestone-extras">
            <div className="settings-milestone-emoji-picker">
              <span className="settings-milestone-emoji-label">{t.settings.milestoneEmoji}</span>
              <EmojiPicker
                value={newEmoji}
                onChange={setNewEmoji}
                searchPlaceholder={t.settings.milestoneEmojiSearch}
                triggerLabel={t.settings.milestoneEmoji}
              />
            </div>
            <div className="settings-milestone-recurring-toggle">
              <button
                type="button"
                className={`settings-milestone-type-btn${newRecurring ? ' active' : ''}`}
                onClick={() => setNewRecurring(true)}
                aria-pressed={newRecurring}
              >{t.settings.milestoneRecurring}</button>
              <button
                type="button"
                className={`settings-milestone-type-btn${!newRecurring ? ' active' : ''}`}
                onClick={() => setNewRecurring(false)}
                aria-pressed={!newRecurring}
              >{t.settings.milestoneOneTime}</button>
            </div>
          </div>
          {errors.length > 0 && (
            <div className="settings-milestone-errors" role="alert">
              {errors.map((e, i) => <span key={i} className="settings-milestone-error">{e}</span>)}
            </div>
          )}
          <div className="settings-milestone-form-actions">
            <button type="submit" className="settings-milestone-save">{t.settings.milestoneSave}</button>
            <button type="button" className="settings-milestone-cancel" onClick={closeForm}>{t.settings.milestoneCancel}</button>
          </div>
        </motion.form>
      )}
    </AnimatePresence>
  )
}
