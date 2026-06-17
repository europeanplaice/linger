import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { ExportButton } from './ExportButton'
import { SettingsSelect } from './SettingsSelect'
import { MilestoneFormModal } from './MilestoneFormModal'
import { shareApp } from '../utils/share'
import { useI18n } from '../i18n'
import type { ThemeMode } from '../hooks/useTheme'
import type { AccentColor } from '../hooks/useAccentColor'
import type { FontSize } from '../hooks/useFontSize'
import type { HolidayCountry } from '../utils/holidays'
import { HOLIDAY_COUNTRY_CODES, isHolidayCountry } from '../utils/holidays'

import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  type Milestone,
} from '../types'

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
  onClose: () => void
  onSignOut: () => void
  email?: string
  milestones?: Milestone[]
  onMilestoneAdd?: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneUpdate?: (id: string, label: string, date: string, emoji?: string, recurring?: boolean) => void
  onMilestoneRemove?: (id: string) => void
  onMilestoneToggleBadge?: (id: string) => void
}

export function SettingsModal({ autoSave, onAutoSaveToggle, themeMode, onThemeModeChange, accentColor, onAccentChange, fontMode, onFontToggle, fontSize, onFontSizeChange, holidayCountry, onHolidayCountryChange, dates, onExport, onClose, onSignOut, email, milestones = [], onMilestoneAdd, onMilestoneUpdate, onMilestoneRemove, onMilestoneToggleBadge }: SettingsModalProps) {
  const { t, locale, language, setLanguage } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<Milestone | null>(null)
  const [milestoneModal, setMilestoneModal] = useState<{ mode: 'add' | 'edit'; milestone?: Milestone } | null>(null)
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

        {/* Account */}
        <div className="settings-section settings-section-account">
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
        <div className="settings-section">
          <h4 className="settings-section-title">{t.settings.sectionAppearance}</h4>
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
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.accentColor}</span>
            <div className="settings-color-picker">
              <button
                type="button"
                className={`settings-color-option ${accentColor === 'indigo' ? 'active' : ''}`}
                onClick={() => onAccentChange('indigo')}
                aria-label={t.settings.accentIndigo}
                aria-pressed={accentColor === 'indigo'}
              >
                <span className="settings-color-swatch" style={{ background: '#5c5fa8' }} />
                <span className="settings-color-label">{t.settings.accentIndigo}</span>
              </button>
              <button
                type="button"
                className={`settings-color-option ${accentColor === 'sage' ? 'active' : ''}`}
                onClick={() => onAccentChange('sage')}
                aria-label={t.settings.accentSage}
                aria-pressed={accentColor === 'sage'}
              >
                <span className="settings-color-swatch" style={{ background: '#4a6a4a' }} />
                <span className="settings-color-label">{t.settings.accentSage}</span>
              </button>
            </div>
          </div>
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
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.autoSave}</span>
              <InfoTip text={t.settings.autoSaveHelp} />
            </span>
            <button
              className={`settings-switch ${autoSave ? 'active' : ''}`}
              onClick={onAutoSaveToggle}
              role="switch"
              aria-checked={autoSave}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
        </div>

        {/* Calendar */}
        <div className="settings-section">
          <h4 className="settings-section-title">{t.settings.sectionCalendar}</h4>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.holidayCountry}</span>
              <InfoTip text={t.settings.holidaysHelp} />
            </span>
            <SettingsSelect
              aria-label={t.settings.holidayCountry}
              value={holidayCountry}
              onChange={val => onHolidayCountryChange(isHolidayCountry(val) ? val : 'off')}
              options={holidayOptions}
            />
          </div>
        </div>

        {/* Milestones */}
        <div className="settings-section">
          <div className="settings-section-title-row">
            <span className="settings-item-label-group">
              <h4 className="settings-section-title">{t.settings.milestones}</h4>
              <InfoTip text={t.settings.milestonesHelp} />
            </span>
            <span className="settings-milestone-usage">
              {t.settings.milestoneUsage(milestones.length, MAX_MILESTONES)}
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
            </div>
          </div>
        </div>

        {/* Data */}
        <div className="settings-section">
          <h4 className="settings-section-title">{t.settings.sectionData}</h4>
          <div className="settings-item">
            <span className="settings-item-label-group">
              <span className="settings-item-label">{t.settings.exportAllEntries}</span>
              <InfoTip text={t.settings.exportHelp} />
            </span>
            <ExportButton dates={dates} onExport={onExport} />
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.shareThisApp}</span>
            <button className="settings-action-btn" onClick={handleShareApp}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              {shareMsg ?? t.settings.share}
            </button>
          </div>
        </div>

        {/* Keyboard Shortcuts (hidden on mobile) */}
        <div className="settings-section settings-shortcuts-section">
          <h4 className="settings-section-title">{t.settings.keyboardShortcuts}</h4>
          <div className="settings-about settings-about-body">
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
        </div>

        {/* About Data Storage */}
        <div className="settings-section">
          <h4 className="settings-section-title">{t.settings.aboutDataStorage}</h4>
          <div className="settings-about settings-about-body">
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
    </motion.dialog>
  )
}


