import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

interface KeyboardShortcutsModalProps {
  onClose: () => void
}

export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose()
  }

  const shortcuts = [
    {
      desc: t.settings.saveEntry,
      keys: isMac ? <><kbd>⌘</kbd><kbd>S</kbd></> : <><kbd>Ctrl</kbd><span>+</span><kbd>S</kbd></>,
    },
    { desc: t.settings.previousNextDay, keys: <><kbd>Alt</kbd><span>+</span><kbd>←</kbd><span>/</span><kbd>→</kbd></> },
    { desc: t.settings.goToToday, keys: <><kbd>Alt</kbd><span>+</span><kbd>↑</kbd></> },
    { desc: t.settings.toggleDarkTheme, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>D</kbd></> },
    { desc: t.settings.toggleSerifFont, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>F</kbd></> },
    {
      desc: t.settings.focusSearch,
      keys: isMac ? <><kbd>⌘</kbd><kbd>K</kbd></> : <><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></>,
    },
  ]

  return (
    <motion.dialog
      ref={dialogRef}
      className="shortcuts-dialog"
      aria-labelledby="shortcuts-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={handleBackdropClick}
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <div className="shortcuts-header">
        <h3 id="shortcuts-title">{t.settings.keyboardShortcuts}</h3>
        <button className="shortcuts-close" onClick={onClose} aria-label={t.app.closeMenu}>×</button>
      </div>
      <div className="shortcuts-body">
        {shortcuts.map(({ desc, keys }, i) => (
          <div className="shortcuts-row" key={i}>
            <span className="shortcuts-desc">{desc}</span>
            <span className="shortcuts-keys">{keys}</span>
          </div>
        ))}
      </div>
    </motion.dialog>
  )
}
