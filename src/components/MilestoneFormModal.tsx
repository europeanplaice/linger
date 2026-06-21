import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { CalendarView } from './CalendarView'
import { EmojiPicker } from './EmojiPicker'
import { useI18n } from '../i18n'
import { MAX_MILESTONE_LABEL_LENGTH, type Milestone } from '../types'

const calendarAnchorSupported = typeof CSS !== 'undefined' && CSS.supports('anchor-name', '--x')

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

export function validateMilestoneFields(
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

export function MilestoneFormModal({ mode, milestone, initialDate, onSave, onClose, t }: {
  mode: 'add' | 'edit'
  milestone?: Milestone
  initialDate?: string
  onSave: (label: string, date: string, emoji?: string, recurring?: boolean) => void
  onClose: () => void
  t: ReturnType<typeof useI18n>['t']
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const labelId = useId()
  const dateId = useId()
  const [label, setLabel] = useState(milestone?.label ?? '')
  const [date, setDate] = useState(milestone?.date ?? initialDate ?? '')
  const [emoji, setEmoji] = useState(milestone?.emoji ?? '🎀')
  const [recurring, setRecurring] = useState(milestone?.recurring ?? true)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const errs = validateMilestoneFields(label, date, t)
    setErrors(errs)
    if (errs.length > 0) return
    onSave(label.trim(), date, emoji || undefined, recurring)
  }

  return (
    <dialog
      ref={dialogRef}
      className="milestone-form-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === dialogRef.current) onClose() }}
    >
      <h4 id={titleId} className="milestone-form-dialog-title">
        {mode === 'add' ? t.settings.milestoneAddTitle : t.settings.milestoneEdit(milestone!.label)}
      </h4>
      <form className="milestone-form-dialog-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor={labelId}>{t.settings.milestoneLabelPlaceholder}</label>
        <input
          id={labelId}
          name="milestone-label"
          className="settings-milestone-input"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={t.settings.milestoneLabelPlaceholder}
          maxLength={MAX_MILESTONE_LABEL_LENGTH}
          autoComplete="off"
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
          <p className="settings-milestone-type-help">
            {recurring ? t.settings.milestoneRecurringHelp : t.settings.milestoneOneTimeHelp}
          </p>
        </div>
        {errors.length > 0 && (
          <div className="settings-milestone-errors" role="alert">
            {errors.map((e, i) => <span key={i} className="settings-milestone-error">{e}</span>)}
          </div>
        )}
        <div className="milestone-form-dialog-actions">
          <button type="button" className="milestone-form-dialog-cancel" onClick={onClose}>{t.settings.milestoneCancel}</button>
          <button type="submit" className="milestone-form-dialog-save">
            {mode === 'add' ? t.settings.milestoneSave : t.settings.milestoneEditSave}
          </button>
        </div>
      </form>
    </dialog>
  )
}
