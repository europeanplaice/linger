import { useCallback, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
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
          <AnimatePresence>
            {listLoading && Array.from({ length: 5 }, (_, i) => (
              <motion.div
                key={i}
                className="history-skeleton-row"
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18, delay: i * 0.025, ease: 'easeOut' }}
              />
            ))}
          </AnimatePresence>
          {!listLoading && listError && (
            <div className="history-list-error">{listError}</div>
          )}
          <motion.ul
            key={listLoading ? 'history-list-loading' : 'history-list-loaded'}
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: {
                transition: {
                  staggerChildren: 0.04,
                  delayChildren: 0.03,
                },
              },
            }}
          >
            {showUnsavedEntry && (
              <motion.li
                variants={{
                  hidden: { opacity: 0, y: 8, scale: 0.98, filter: 'blur(3px)' },
                  show: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
                }}
                transition={{ type: 'spring', stiffness: 520, damping: 34 }}
              >
                <button
                  type="button"
                  className={`history-revision-item${selectedId === '__unsaved__' ? ' selected' : ''}`}
                  onClick={() => selectRevision('__unsaved__')}
                  aria-current={selectedId === '__unsaved__' ? 'true' : undefined}
                >
                  <span className="history-revision-time">{t.history.unsaved}</span>
                  <span className="history-revision-badge unsaved-badge">{t.history.unsaved}</span>
                </button>
              </motion.li>
            )}
            {!listLoading && !listError && revisions.map((rev, i) => (
              <motion.li
                key={rev.id}
                variants={{
                  hidden: { opacity: 0, y: 8, scale: 0.98, filter: 'blur(3px)' },
                  show: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
                }}
                transition={{ type: 'spring', stiffness: 520, damping: 34 }}
              >
                <button
                  type="button"
                  className={`history-revision-item${selectedId === rev.id ? ' selected' : ''}`}
                  onClick={() => selectRevision(rev.id)}
                  aria-current={selectedId === rev.id ? 'true' : undefined}
                >
                  <span className="history-revision-time">{formatRevisionTime(rev.modifiedTime, locale, t.dates)}</span>
                  {i === 0 && !showUnsavedEntry && <span className="history-revision-badge">{t.history.current}</span>}
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </div>
        <div className="history-preview-pane">
          <AnimatePresence>
            {previewLoading && (
              <motion.div
                className="history-preview-skeleton"
                initial={{ opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                transition={{ duration: 0.18, ease: 'easeInOut' }}
              >
                {[80, 65, 90, 40, 75, 55].map((w, i) => (
                  <motion.div
                    key={i}
                    className={`history-preview-skeleton-row${w <= 45 ? ' short' : w <= 70 ? ' medium' : ''}`}
                    style={{ width: `${w}%` }}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.16, delay: i * 0.025, ease: 'easeOut' }}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          {!previewLoading && previewError && (
            <motion.div
              key={`history-preview-error-${selectedId ?? 'none'}`}
              className="history-preview-error"
              initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              {previewError}
            </motion.div>
          )}
          {!previewLoading && !previewError && diffHtml && (
            <motion.div
              key={`history-preview-diff-${selectedId ?? 'none'}`}
              className="history-preview-diff"
              dangerouslySetInnerHTML={{ __html: diffHtml }}
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
            />
          )}
          {!previewLoading && !previewError && !diffHtml && (
            <motion.div
              key={`history-preview-text-${selectedId ?? 'none'}`}
              className="history-preview-diff"
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
            >
              {previewContent ?? ''}
            </motion.div>
          )}
          <div className="history-modal-footer">
            {restoreError && <span className="history-restore-error">{restoreError}</span>}
            <button
              className="btn-restore"
              onClick={restore}
              disabled={listLoading || previewLoading || isCurrentRevision || isUnsavedRevision || restoring || !previewContent || !!previewError}
            >
              {restoring ? t.history.restoring : t.history.restoreThisVersion}
            </button>
          </div>
        </div>
      </div>
    </motion.dialog>
  )
}
