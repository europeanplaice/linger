import { useState, useRef, useEffect, useCallback } from 'react'

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

export function SettingsSelect({ value, onChange, options, 'aria-label': ariaLabel }: SettingsSelectProps) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selectedLabel = options.find(o => o.value === value)?.label ?? value

  const close = useCallback(() => {
    setOpen(false)
    setFocusedIndex(-1)
  }, [])

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
      setOpen(true)
      setFocusedIndex(options.findIndex(o => o.value === value))
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
      close()
    }
  }

  return (
    <div className="settings-select" ref={containerRef}>
      <button
        type="button"
        className={`settings-select-trigger ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) {
            close()
          } else {
            setOpen(true)
            setFocusedIndex(options.findIndex(o => o.value === value))
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedLabel}</span>
        <svg className="settings-select-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          className="settings-select-dropdown"
          role="listbox"
          ref={listRef}
          aria-label={ariaLabel}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              className={`settings-select-option ${option.value === value ? 'selected' : ''}`}
              onMouseDown={() => {
                onChange(option.value)
                close()
              }}
              onKeyDown={e => handleOptionKeyDown(e, index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
