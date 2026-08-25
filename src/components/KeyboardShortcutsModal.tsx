import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'

interface KeyboardShortcutsModalProps {
  onClose: () => void
}

export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleClose = () => onClose()
    dialog.addEventListener('close', handleClose)
    return () => dialog.removeEventListener('close', handleClose)
  }, [onClose])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) dialogRef.current?.close()
  }

  const shortcuts = [
    { desc: t.settings.saveEntry, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>S</kbd></> },
    { desc: t.settings.previousNextDay, keys: <><kbd>Alt</kbd><span>+</span><kbd>←</kbd><span>/</span><kbd>→</kbd></> },
    { desc: t.settings.goToToday, keys: <><kbd>Alt</kbd><span>+</span><kbd>↑</kbd></> },
    { desc: t.settings.toggleDarkTheme, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>D</kbd></> },
    { desc: t.settings.toggleSerifFont, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>F</kbd></> },
    { desc: t.settings.focusSearch, keys: <><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></> },
  ]

  return (
    <dialog ref={dialogRef} className="shortcuts-dialog" onClick={handleBackdropClick}>
      <div className="shortcuts-header">
        <h3>{t.settings.keyboardShortcuts}</h3>
        <button className="shortcuts-close" onClick={() => dialogRef.current?.close()} aria-label={t.app.closeMenu}>×</button>
      </div>
      <div className="shortcuts-body">
        {shortcuts.map(({ desc, keys }, i) => (
          <div className="shortcuts-row" key={i}>
            <span className="shortcuts-desc">{desc}</span>
            <span className="shortcuts-keys">{keys}</span>
          </div>
        ))}
      </div>
    </dialog>
  )
}
