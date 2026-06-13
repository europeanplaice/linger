import { useState, useEffect, useCallback, useRef } from 'react'
import type { Anniversary } from '../types'
import { loadAnniversaries, saveAnniversaries, TokenExpiredError } from '../api/driveAnniversaries'
import { useLatestRef } from './useEvent'

const STORAGE_KEY = 'linger_anniversaries'

function loadLocal(): Anniversary[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

function saveLocal(list: Anniversary[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {}
}

let nextId = 1
function generateId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return String(Date.now()) + String(nextId++)
  }
}

export function useAnniversaries(
  authStatus: string,
  onTokenExpired: () => void,
) {
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>(loadLocal)
  const onTokenExpiredRef = useLatestRef(onTokenExpired)

  useEffect(() => {
    if (authStatus !== 'signedIn') return
    let cancelled = false
    loadAnniversaries()
      .then(list => {
        if (!cancelled) {
          setAnniversaries(list)
          saveLocal(list)
        }
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
      })
    return () => { cancelled = true }
  }, [authStatus, onTokenExpiredRef])

  const driveSyncRef = useRef<Promise<void> | null>(null)

  const persist = useCallback((next: Anniversary[]) => {
    setAnniversaries(next)
    saveLocal(next)
    driveSyncRef.current = saveAnniversaries(next).catch(e => {
      if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
    })
  }, [onTokenExpiredRef])

  const add = useCallback((label: string, monthDay: string) => {
    const next = [...anniversaries, { id: generateId(), label, monthDay }]
    persist(next)
  }, [anniversaries, persist])

  const remove = useCallback((id: string) => {
    const next = anniversaries.filter(a => a.id !== id)
    persist(next)
  }, [anniversaries, persist])

  const update = useCallback((id: string, label: string, monthDay: string) => {
    const next = anniversaries.map(a => a.id === id ? { ...a, label, monthDay } : a)
    persist(next)
  }, [anniversaries, persist])

  return { anniversaries, add, remove, update }
}
