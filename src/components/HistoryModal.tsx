import { useCallback, useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import type { LoadedDiaryEntry } from '../types'
import { useRevisions } from '../hooks/useRevisions'
import { formatRevisionTime } from '../utils/date'
import { useI18n } from '../i18n'

interface Props {
  date: string
  fileId: string
  baseVersion: string | null
  text: string
  savedText: string
  isDirty: boolean
  autoSave: boolean
  onSave: (date: string, content: string, baseVersion: string | null, force?: boolean, baseContent?: string | null) => Promise<LoadedDiaryEntry>
  onRestored: (result: LoadedDiaryEntry) => void
  onClose: () => void
  onExpired: () => void
}

export function HistoryModal({ date, fileId, baseVersion, text, savedText, isDirty, autoSave, onSave, onRestored, onClose, onExpired }: Props) {
  const { t, locale } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const {
    revisions, showUnsavedEntry, listLoading, listError,
    selectedId, previewContent, previewLoading, previewError,
    diffHtml, restoring, restoreError,
    selectRevision, restore,
  } = useRevisions({
    fileId,
    date,
    baseVersion,
    text,
    savedText,
    isDirty,
    autoSave,
    onSave,
    onRestored,
    onExpired,
    messages: {
      failedToLoadHistory: t.history.failedToLoadHistory,
      failedToLoadVersion: t.history.failedToLoadVersion,
      restoreConflict: t.history.restoreConflict,
      restoreFailed: t.history.restoreFailed,
    },
  })

  const isCurrentRevision = revisions.length > 0 && selectedId === revisions[0].id
  const isUnsavedRevision = selectedId === '__unsaved__'

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

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
      className="history-dialog"
      aria-labelledby="history-title"
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <div className="history-modal-header">
        <h3 id="history-title">{t.history.title}</h3>
        <button className="history-modal-close" onClick={onClose} aria-label={t.common.close}>×</button>
      </div>
      <div className="history-modal-body">
        <div className="history-revision-list">
          {listLoading && Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="history-skeleton-row" />
          ))}
          {!listLoading && listError && (
            <div className="history-list-error">{listError}</div>
          )}
          {showUnsavedEntry && (
            <div
              className={`history-revision-item${selectedId === '__unsaved__' ? ' selected' : ''}`}
              onClick={() => selectRevision('__unsaved__')}
            >
              <span className="history-revision-time">{t.history.unsaved}</span>
              <span className="history-revision-badge unsaved-badge">{t.history.unsaved}</span>
            </div>
          )}
          {!listLoading && !listError && revisions.map((rev, i) => (
            <div
              key={rev.id}
              className={`history-revision-item${selectedId === rev.id ? ' selected' : ''}`}
              onClick={() => selectRevision(rev.id)}
            >
              <span className="history-revision-time">{formatRevisionTime(rev.modifiedTime, locale, t.dates)}</span>
              {i === 0 && !showUnsavedEntry && <span className="history-revision-badge">{t.history.current}</span>}
            </div>
          ))}
        </div>
        <div className="history-preview-pane">
          {previewLoading && (
            <div className="history-preview-skeleton">
              {[80, 65, 90, 40, 75, 55].map((w, i) => (
                <div
                  key={i}
                  className={`history-preview-skeleton-row${w <= 45 ? ' short' : w <= 70 ? ' medium' : ''}`}
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          )}
          {!previewLoading && previewError && (
            <div className="history-preview-error">{previewError}</div>
          )}
          {!previewLoading && !previewError && diffHtml && (
            <div
              className="history-preview-diff"
              dangerouslySetInnerHTML={{ __html: diffHtml }}
            />
          )}
          {!previewLoading && !previewError && !diffHtml && (
            <div className="history-preview-diff">
              {previewContent ?? ''}
            </div>
          )}
          <div className="history-modal-footer">
            {restoreError && <span className="history-restore-error">{restoreError}</span>}
            <button
              className="btn-restore"
              onClick={restore}
              disabled={isCurrentRevision || isUnsavedRevision || restoring || !previewContent}
            >
              {restoring ? t.history.restoring : t.history.restoreThisVersion}
            </button>
          </div>
        </div>
      </div>
    </motion.dialog>
  )
}
