import { useState, useEffect, useCallback, useRef } from 'react'
import {
  MAX_ANNIVERSARIES,
  MAX_ANNIVERSARY_BADGES,
  normalizeAnniversaries,
  type Anniversary,
} from '../types'
import { loadAnniversaries, saveAnniversaries, TokenExpiredError } from '../api/driveAnniversaries'
import { useLatestRef } from './useEvent'

const STORAGE_KEY = 'linger_anniversaries'
const PENDING_STORAGE_KEY = 'linger_anniversaries_pending'

function loadLocal(): Anniversary[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return normalizeAnniversaries(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveLocal(list: Anniversary[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch { /* ignore */ }
}

function setPendingLocal(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_STORAGE_KEY, 'true')
    else localStorage.removeItem(PENDING_STORAGE_KEY)
  } catch { /* ignore */ }
}

function hasPendingLocal(): boolean {
  try {
    return localStorage.getItem(PENDING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
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
  const anniversariesRef = useRef(anniversaries)
  const mutationVersionRef = useRef(0)
  const syncVersionRef = useRef(0)
  const driveSyncRef = useRef<Promise<void> | null>(null)
  const pendingRetryStartedRef = useRef(false)
  const onTokenExpiredRef = useLatestRef(onTokenExpired)

  const persist = useCallback((next: Anniversary[]) => {
    saveLocal(next)
    setPendingLocal(true)
    const syncVersion = ++syncVersionRef.current
    const previous = driveSyncRef.current ?? Promise.resolve()
    driveSyncRef.current = previous
      .catch(() => undefined)
      .then(() => saveAnniversaries(next))
      .then(() => {
        if (syncVersionRef.current === syncVersion) setPendingLocal(false)
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
        else console.error('Failed to sync anniversaries to Drive:', e)
      })
  }, [onTokenExpiredRef])

  useEffect(() => {
    if (authStatus !== 'signedIn') {
      pendingRetryStartedRef.current = false
      return
    }
    if (hasPendingLocal()) {
      if (pendingRetryStartedRef.current) return
      pendingRetryStartedRef.current = true
      persist(anniversariesRef.current)
      // Re-arm the latch on settle so a transient failure retries next auth cycle.
      // Intentional last-write-wins: local state is pushed without loading remote,
      // so concurrent edits on another device are overwritten.
      driveSyncRef.current?.finally(() => {
        pendingRetryStartedRef.current = false
      })
      return
    }
    let cancelled = false
    const loadVersion = mutationVersionRef.current
    loadAnniversaries()
      .then(list => {
        if (!cancelled && mutationVersionRef.current === loadVersion) {
          anniversariesRef.current = list
          setAnniversaries(list)
          saveLocal(list)
        }
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
      })
    return () => { cancelled = true }
  }, [authStatus, onTokenExpiredRef, persist])

  const add = useCallback((label: string, date: string) => {
    if (anniversariesRef.current.length >= MAX_ANNIVERSARIES) return
    const enabledBadges = anniversariesRef.current.filter(a => a.showBadge !== false).length
    const next = [
      ...anniversariesRef.current,
      {
        id: generateId(),
        label,
        date,
        ...(enabledBadges >= MAX_ANNIVERSARY_BADGES ? { showBadge: false } : {}),
      },
    ]
    mutationVersionRef.current += 1
    anniversariesRef.current = next
    setAnniversaries(next)
    persist(next)
  }, [persist])

  const remove = useCallback((id: string) => {
    const next = anniversariesRef.current.filter(a => a.id !== id)
    mutationVersionRef.current += 1
    anniversariesRef.current = next
    setAnniversaries(next)
    persist(next)
  }, [persist])

  const update = useCallback((id: string, label: string, date: string) => {
    const next = anniversariesRef.current.map(a =>
      a.id === id ? { ...a, label, date } : a
    )
    mutationVersionRef.current += 1
    anniversariesRef.current = next
    setAnniversaries(next)
    persist(next)
  }, [persist])

  const toggleBadge = useCallback((id: string) => {
    const target = anniversariesRef.current.find(a => a.id === id)
    if (!target) return
    if (
      target.showBadge === false
      && anniversariesRef.current.filter(a => a.showBadge !== false).length >= MAX_ANNIVERSARY_BADGES
    ) {
      return
    }
    const next = anniversariesRef.current.map(a => a.id === id ? { ...a, showBadge: a.showBadge === false ? undefined : false } : a)
    mutationVersionRef.current += 1
    anniversariesRef.current = next
    setAnniversaries(next)
    persist(next)
  }, [persist])

  return { anniversaries, add, update, remove, toggleBadge }
}
