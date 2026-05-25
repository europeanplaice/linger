import { useState, useEffect, useCallback } from 'react'

type FontMode = 'serif' | 'sans'

const STORAGE_KEY = 'linger_font'

declare global {
  interface Window {
    __fontUrls?: Record<string, string>
  }
}

function readStoredFont(): FontMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'sans') return 'sans'
  return 'serif'
}

function applyFont(mode: FontMode) {
  document.documentElement.setAttribute('data-font', mode)
}

function ensureFontLoaded(mode: FontMode) {
  const id = `linger-font-${mode}`
  if (document.getElementById(id)) return
  const url = window.__fontUrls?.[mode]
  if (!url) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = url
  document.head.appendChild(link)
}

export function useFont() {
  const [mode, setMode] = useState<FontMode>(readStoredFont)

  useEffect(() => {
    applyFont(mode)
  }, [mode])

  const toggleFont = useCallback(() => {
    setMode(prev => {
      const next: FontMode = prev === 'serif' ? 'sans' : 'serif'
      ensureFontLoaded(next)
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  return { mode, toggleFont }
}
