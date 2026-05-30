import { useState, useRef, useEffect, useCallback, useId } from 'react'

interface Option {
  value: string
  label: string
}

interface SettingsSelectProps {
  value: string
  onChange: (value: string) => void
  options: Option[]
  'aria-label'?: string
}

const anchorSupported = typeof CSS !== 'undefined' && CSS.supports('anchor-name', '--x')

export function SettingsSelect({ value, onChange, options, 'aria-label': ariaLabel }: SettingsSelectProps) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const uid = useId().replace(/[^a-z0-9]/gi, '-').replace(/^-|-$/g, '')

  const selectedLabel = options.find(o => o.value === value)?.label ?? value

  const close = useCallback(() => {
    if ('hidePopover' in HTMLElement.prototype) listRef.current?.hidePopover()
    setOpen(false)
    setFocusedIndex(-1)
    triggerRef.current?.focus()
  }, [])

  const doOpen = useCallback(() => {
    const popover = listRef.current
    const trigger = triggerRef.current
    if (!popover) return
    // Fallback positioning for browsers without CSS Anchor Positioning
    if (!anchorSupported && trigger) {
      const rect = trigger.getBoundingClientRect()
      popover.style.top = `${rect.bottom + 4}px`
      popover.style.right = `${window.innerWidth - rect.right}px`
      popover.style.minWidth = `${rect.width}px`
    }
    if ('showPopover' in HTMLElement.prototype) popover.showPopover()
    setOpen(true)
    setFocusedIndex(options.findIndex(o => o.value === value))
  }, [options, value])

  // anchor-name / position-anchor are not in React CSSProperties yet — set via DOM
  useEffect(() => {
    if (!anchorSupported) return
    const name = `--ss-${uid}`
    triggerRef.current?.style.setProperty('anchor-name', name)
    listRef.current?.style.setProperty('position-anchor', name)
  }, [uid])

  // Close on outside click (popover="manual" has no built-in light dismiss)
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, close])

  useEffect(() => {
    if (open && focusedIndex >= 0) {
      const items = listRef.current?.querySelectorAll<HTMLLIElement>('[role="option"]')
      items?.[focusedIndex]?.focus()
    }
  }, [open, focusedIndex])

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      doOpen()
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function handleOptionKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex(Math.min(index + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex(Math.max(index - 1, 0))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(options[index].value)
      close()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      close()
    }
  }

  return (
    <div className="settings-select" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`settings-select-trigger ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => open ? close() : doOpen()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedLabel}</span>
        <svg className="settings-select-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <ul
        ref={listRef}
        popover="manual"
        className="settings-select-dropdown"
        role="listbox"
        aria-label={ariaLabel}
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            role="option"
            aria-selected={option.value === value}
            tabIndex={-1}
            className={`settings-select-option ${option.value === value ? 'selected' : ''}`}
            onMouseDown={e => {
              if (e.button !== 0) return
              onChange(option.value)
              close()
            }}
            onKeyDown={e => handleOptionKeyDown(e, index)}
          >
            <svg className="settings-select-check" aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 9 6 13 14 4" />
            </svg>
            {option.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
