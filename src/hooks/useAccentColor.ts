import { useState, useEffect, useCallback } from 'react'

export type AccentColor = 'indigo' | 'sage' | 'terracotta'

const STORAGE_KEY = 'linger_accent'

function readStoredAccent(): AccentColor {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'sage') return 'sage'
  if (stored === 'terracotta') return 'terracotta'
  return 'indigo'
}

function applyAccent(color: AccentColor) {
  document.documentElement.setAttribute('data-accent', color)
}

export function useAccentColor() {
  const [accent, setAccentState] = useState<AccentColor>(readStoredAccent)

  useEffect(() => {
    applyAccent(accent)
  }, [accent])

  const setAccent = useCallback((next: AccentColor) => {
    localStorage.setItem(STORAGE_KEY, next)
    setAccentState(next)
  }, [])

  return { accent, setAccent }
}
