import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ExportButton } from './ExportButton'
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
  onExport: (format: 'txt' | 'md', onProgress: (done: number, total: number) => void) => Promise<{ date: string; content: string }[]>
  onClose: () => void
  email?: string
}

export function SettingsModal({ autoSave, onAutoSaveToggle, themeMode, onThemeModeChange, fontMode, onFontToggle, fontSize, onFontSizeChange, dates, onExport, onClose, email }: SettingsModalProps) {
  const { t, language, setLanguage } = useI18n()
  const overlayRef = useRef<HTMLDivElement>(null)
  const [shareMsg, setShareMsg] = useState<string | null>(null)

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

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <motion.div className="settings-overlay" ref={overlayRef} onClick={handleOverlayClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div className="settings-modal"
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      >
        <div className="settings-modal-header">
          <h3>{t.settings.title}</h3>
          <button className="settings-modal-close" onClick={onClose} aria-label={t.settings.close}>×</button>
        </div>
        <div className="settings-list">
          <div className="settings-item">
            <span className="settings-item-label">{t.common.language}</span>
            <select
              className="settings-language-select"
              aria-label={t.common.language}
              value={language}
              onChange={event => setLanguage(event.target.value === 'en' ? 'en' : 'ja')}
            >
              <option value="ja">{t.common.japanese}</option>
              <option value="en">{t.common.english}</option>
            </select>
          </div>
          <div className="settings-divider" />
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.theme}</span>
            <select
              className="settings-language-select"
              aria-label={t.settings.theme}
              value={themeMode}
              onChange={e => onThemeModeChange(e.target.value as ThemeMode)}
            >
              <option value="light">{t.settings.themeLight}</option>
              <option value="dark">{t.settings.themeDark}</option>
              <option value="system">{t.settings.themeSystem}</option>
            </select>
          </div>
          <div className="settings-divider" />
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.serifFont}</span>
            <button
              className={`settings-switch ${fontMode === 'serif' ? 'active' : ''}`}
              onClick={onFontToggle}
              role="switch"
              aria-checked={fontMode === 'serif'}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
          <div className="settings-divider" />
          <div className="settings-item">
            <span className="settings-item-label">{t.settings.fontSize}</span>
            <select
              className="settings-language-select"
              aria-label={t.settings.fontSize}
              value={fontSize}
              onChange={e => onFontSizeChange(e.target.value as FontSize)}
            >
              <option value="sm">{t.settings.fontSizeSm}</option>
              <option value="md">{t.settings.fontSizeMd}</option>
              <option value="lg">{t.settings.fontSizeLg}</option>
              <option value="xl">{t.settings.fontSizeXl}</option>
            </select>
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
      </motion.div>
    </motion.div>
  )
}
