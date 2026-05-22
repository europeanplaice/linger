import { useState, useEffect, useCallback } from 'react'

export type FontSize = 'sm' | 'md' | 'lg' | 'xl'

const STORAGE_KEY = 'linger_fontsize'

const FONT_SIZE_VALUES: Record<FontSize, string> = {
  sm: '1rem',
  md: '1.1rem',
  lg: '1.25rem',
  xl: '1.4rem',
}

function readStoredFontSize(): FontSize {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'sm' || stored === 'md' || stored === 'lg' || stored === 'xl') return stored
  return 'md'
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.setProperty('--editor-font-size', FONT_SIZE_VALUES[size])
}

export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSize>(readStoredFontSize)

  useEffect(() => {
    applyFontSize(fontSize)
  }, [fontSize])

  const setFontSize = useCallback((next: FontSize) => {
    localStorage.setItem(STORAGE_KEY, next)
    setFontSizeState(next)
  }, [])

  return { fontSize, setFontSize }
}
