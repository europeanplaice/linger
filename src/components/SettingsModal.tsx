import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ExportButton } from './ExportButton'
import { SettingsSelect } from './SettingsSelect'
import { shareApp } from '../utils/share'
import { useI18n } from '../i18n'
import type { ThemeMode } from '../hooks/useTheme'
import type { FontSize } from '../hooks/useFontSize'

interface SettingsModalProps {
  autoSave: boolean
  onAutoSaveToggle: () => void
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  fontMode: 'serif' | 'sans'
  onFontToggle: () => void
  fontSize: FontSize
  onFontSizeChange: (size: FontSize) => void
  dates: string[]
  onExport: (onProgress: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
  onClose: () => void
  onSignOut: () => void
  email?: string
}

export function SettingsModal({ autoSave, onAutoSaveToggle, themeMode, onThemeModeChange, fontMode, onFontToggle, fontSize, onFontSizeChange, dates, onExport, onClose, onSignOut, email }: SettingsModalProps) {
  const { t, language, setLanguage } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [shareMsg, setShareMsg] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

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
          <button className="settings-action-btn settings-signout-btn" onClick={onSignOut}>
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
    </motion.dialog>
  )
}
