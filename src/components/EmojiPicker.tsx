import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type EmojiEntry = { e: string; t: string }
type Category = { id: string; icon: string; label: string; entries: EmojiEntry[] }

type UnicodeEmojiGroup = {
  name: string
  slug: string
  emojis: Array<{ emoji: string; slug: string }>
}

const GROUP_CONFIG = [
  { name: 'Smileys & Emotion', id: 'smileys',    icon: '😊', label: 'Smileys'    },
  { name: 'People & Body',     id: 'people',     icon: '🧑', label: 'People'     },
  { name: 'Animals & Nature',  id: 'nature',     icon: '🌸', label: 'Nature'     },
  { name: 'Food & Drink',      id: 'food',       icon: '🍰', label: 'Food'       },
  { name: 'Travel & Places',   id: 'travel',     icon: '✈️', label: 'Travel'     },
  { name: 'Activities',        id: 'activities', icon: '⚽', label: 'Activities' },
  { name: 'Objects',           id: 'objects',    icon: '💡', label: 'Objects'    },
  { name: 'Symbols',           id: 'symbols',    icon: '❤️', label: 'Symbols'    },
  { name: 'Flags',             id: 'flags',      icon: '🏁', label: 'Flags'      },
]

let _cache: { categories: Category[]; all: EmojiEntry[] } | null = null

async function loadEmojiData(): Promise<{ categories: Category[]; all: EmojiEntry[] }> {
  if (_cache) return _cache
  const { default: groups } = await import('unicode-emoji-json/data-by-group.json')
  const data = groups as UnicodeEmojiGroup[]
  const categories = GROUP_CONFIG.map(cfg => {
    const group = data.find(g => g.name === cfg.name)
    return {
      id: cfg.id,
      icon: cfg.icon,
      label: cfg.label,
      entries: group
        ? group.emojis.map(({ emoji, slug }) => ({ e: emoji, t: slug.replace(/_/g, ' ') }))
        : [],
    }
  })
  _cache = { categories, all: categories.flatMap(c => c.entries) }
  return _cache
}

interface EmojiPickerProps {
  value: string
  onChange: (emoji: string) => void
  searchPlaceholder?: string
  triggerLabel?: string
}

export function EmojiPicker({ value, onChange, searchPlaceholder = 'Search…', triggerLabel = 'Pick emoji' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState(GROUP_CONFIG[0].id)
  const [categories, setCategories] = useState<Category[]>([])
  const [allEntries, setAllEntries] = useState<EmojiEntry[]>([])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({})
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(() => document.body)

  // Preload data when the picker mounts
  useEffect(() => {
    loadEmojiData().then(({ categories, all }) => {
      setCategories(categories)
      setAllEntries(all)
    })
  }, [])

  const openPicker = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const closestDialog = triggerRef.current?.closest<HTMLElement>('dialog[open]') ?? document.body
    setPortalTarget(closestDialog)
    const popoverHeight = 310
    const popoverWidth = 272
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const openUpward = spaceBelow < popoverHeight && rect.top > popoverHeight
    const left = Math.min(rect.left, window.innerWidth - popoverWidth - 8)
    setPopoverStyle(
      openUpward
        ? { bottom: window.innerHeight - rect.top + 4, left: Math.max(left, 8) }
        : { top: rect.bottom + 4, left: Math.max(left, 8) }
    )
    setOpen(true)
    setSearch('')
  }

  const closePicker = () => {
    setOpen(false)
    setSearch('')
  }

  useEffect(() => {
    if (!open) return
    setTimeout(() => searchRef.current?.focus(), 30)
    const onMouseDown = (e: MouseEvent) => {
      if (
        popoverRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) return
      closePicker()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker() }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const filtered = search.trim()
    ? allEntries.filter(({ t }) => t.split(' ').some(tag => tag.startsWith(search.toLowerCase())))
    : categories.find(c => c.id === activeCategory)?.entries ?? []

  const selectEmoji = (e: string) => {
    onChange(e === value ? '' : e)
    closePicker()
  }

  return (
    <div className="emoji-picker-root">
      <button
        ref={triggerRef}
        type="button"
        className={`emoji-picker-trigger${value ? ' has-value' : ''}${open ? ' open' : ''}`}
        onClick={open ? closePicker : openPicker}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="emoji-picker-trigger-icon">{value || '🙂'}</span>
        <svg className="emoji-picker-trigger-caret" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="emoji-picker-popover"
          style={popoverStyle}
          role="dialog"
          aria-label={triggerLabel}
        >
          <div className="emoji-picker-search-row">
            <input
              ref={searchRef}
              className="emoji-picker-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              type="search"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {!search && (
            <div className="emoji-picker-cats" role="tablist">
              {categories.map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  className={`emoji-picker-cat-btn${activeCategory === cat.id ? ' active' : ''}`}
                  onClick={() => setActiveCategory(cat.id)}
                  title={cat.label}
                  aria-selected={activeCategory === cat.id}
                >{cat.icon}</button>
              ))}
            </div>
          )}
          <div className="emoji-picker-grid" role="listbox">
            {categories.length === 0 && (
              <span className="emoji-picker-empty">Loading…</span>
            )}
            {categories.length > 0 && filtered.length === 0 && (
              <span className="emoji-picker-empty">No results</span>
            )}
            {filtered.map(({ e }) => (
              <button
                key={e}
                type="button"
                role="option"
                aria-selected={value === e}
                className={`emoji-picker-btn${value === e ? ' active' : ''}`}
                onClick={() => selectEmoji(e)}
              >{e}</button>
            ))}
          </div>
        </div>,
        portalTarget
      )}
    </div>
  )
}
