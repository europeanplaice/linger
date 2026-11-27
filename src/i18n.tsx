import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { en, type Dictionary } from './i18n/en'

export type Language = 'ja' | 'en'

const STORAGE_KEY = 'linger_language'

const loadedDictionaries: Partial<Record<Language, Dictionary>> = { en }
const inflightLoads: Partial<Record<Language, Promise<Dictionary>>> = {}

function loadDictionary(language: Language): Promise<Dictionary> {
  const existing = loadedDictionaries[language]
  if (existing) return Promise.resolve(existing)
  const inflight = inflightLoads[language]
  if (inflight) return inflight

  const loader = language === 'ja'
    ? import('./i18n/ja').then((mod) => {
        loadedDictionaries.ja = mod.ja
        return mod.ja
      })
    : Promise.resolve(en)

  inflightLoads[language] = loader.finally(() => {
    delete inflightLoads[language]
  })
  return inflightLoads[language]!
}

export function preloadLanguage(language?: Language): Promise<void> {
  const target = language ?? readStoredLanguage()
  if (loadedDictionaries[target]) return Promise.resolve()
  return loadDictionary(target).then(() => {})
}

interface I18nContextValue {
  language: Language
  locale: string
  t: Dictionary
  setLanguage: (language: Language) => void
}

function readStoredLanguage(): Language {
  // Guarded for Node: the build-time prerender renders this provider server-side.
  if (typeof window === 'undefined') return 'en'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'ja') {
    return stored
  }
  const browserLang = navigator.language.split('-')[0]
  if (browserLang === 'en') return 'en'
  if (browserLang === 'ja') return 'ja'
  return 'ja'
}

function getLocale(language: Language): string {
  switch (language) {
    case 'en':
      return 'en-US'
    case 'ja':
      return 'ja-JP'
  }
}

function getDictionary(language: Language): Dictionary {
  return loadedDictionaries[language] ?? en
}

const fallbackContext: I18nContextValue = {
  language: 'en',
  locale: 'en-US',
  t: en,
  setLanguage: () => {},
}

const I18nContext = createContext<I18nContextValue>(fallbackContext)

export function I18nProvider({
  children,
  initialLanguage,
}: {
  children: ReactNode
  // Forces a language regardless of storage; used by the build-time prerender so
  // the canonical static HTML at `/` is always English.
  initialLanguage?: Language
}) {
  const [language, setLanguageState] = useState<Language>(
    () => initialLanguage ?? readStoredLanguage(),
  )
  const [dictVersion, setDictVersion] = useState(0)
  const switchGenerationRef = useRef(0)

  useEffect(() => {
    if (loadedDictionaries[language]) return
    let cancelled = false
    void loadDictionary(language).then(() => {
      if (!cancelled) setDictVersion(v => v + 1)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [language])

  const setLanguage = useCallback((nextLanguage: Language) => {
    const generation = ++switchGenerationRef.current
    try {
      localStorage.setItem(STORAGE_KEY, nextLanguage)
    } catch {
      // Storage may be unavailable (private mode / SSR); language still applies in-memory.
    }
    if (loadedDictionaries[nextLanguage]) {
      setLanguageState(nextLanguage)
      return
    }
    void loadDictionary(nextLanguage).then(() => {
      if (generation !== switchGenerationRef.current) return
      setDictVersion(v => v + 1)
      setLanguageState(nextLanguage)
    }).catch(() => {
      if (generation !== switchGenerationRef.current) return
      setLanguageState(nextLanguage)
    })
  }, [])

  const value = useMemo<I18nContextValue>(() => ({
    language,
    locale: getLocale(language),
    t: getDictionary(language),
    setLanguage,
  }), [language, setLanguage, dictVersion])

  useEffect(() => {
    document.documentElement.lang = language
    document.title = getDictionary(language).documentTitle
  }, [language, dictVersion])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
