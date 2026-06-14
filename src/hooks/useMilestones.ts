import { useState, useEffect, useCallback, useRef } from 'react'
import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  normalizeMilestones,
  type Milestone,
} from '../types'
import { loadMilestones, saveMilestones, TokenExpiredError } from '../api/driveMilestones'
import { useLatestRef } from './useEvent'

const STORAGE_KEY = 'linger_milestones'
const PENDING_STORAGE_KEY = 'linger_milestones_pending'

function loadLocal(): Milestone[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return normalizeMilestones(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveLocal(list: Milestone[]): void {
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

export function useMilestones(
  authStatus: string,
  onTokenExpired: () => void,
) {
  const [milestones, setMilestones] = useState<Milestone[]>(loadLocal)
  const milestonesRef = useRef(milestones)
  const mutationVersionRef = useRef(0)
  const syncVersionRef = useRef(0)
  const driveSyncRef = useRef<Promise<void> | null>(null)
  const pendingRetryStartedRef = useRef(false)
  const onTokenExpiredRef = useLatestRef(onTokenExpired)

  const persist = useCallback((next: Milestone[]) => {
    saveLocal(next)
    setPendingLocal(true)
    const syncVersion = ++syncVersionRef.current
    const previous = driveSyncRef.current ?? Promise.resolve()
    driveSyncRef.current = previous
      .catch(() => undefined)
      .then(() => saveMilestones(next))
      .then(() => {
        if (syncVersionRef.current === syncVersion) setPendingLocal(false)
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
        else console.error('Failed to sync milestones to Drive:', e)
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
      persist(milestonesRef.current)
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
    loadMilestones()
      .then(list => {
        if (!cancelled && mutationVersionRef.current === loadVersion) {
          milestonesRef.current = list
          setMilestones(list)
          saveLocal(list)
        }
      })
      .catch(e => {
        if (e instanceof TokenExpiredError) onTokenExpiredRef.current()
      })
    return () => { cancelled = true }
  }, [authStatus, onTokenExpiredRef, persist])

  const add = useCallback((label: string, date: string, emoji?: string, recurring?: boolean) => {
    if (milestonesRef.current.length >= MAX_MILESTONES) return
    const enabledBadges = milestonesRef.current.filter(a => a.showBadge !== false).length
    const next = [
      ...milestonesRef.current,
      {
        id: generateId(),
        label,
        date,
        ...(enabledBadges >= MAX_MILESTONE_BADGES ? { showBadge: false } : {}),
        ...(emoji ? { emoji } : {}),
        ...(recurring !== undefined ? { recurring } : {}),
      },
    ]
    mutationVersionRef.current += 1
    milestonesRef.current = next
    setMilestones(next)
    persist(next)
  }, [persist])

  const remove = useCallback((id: string) => {
    const next = milestonesRef.current.filter(a => a.id !== id)
    mutationVersionRef.current += 1
    milestonesRef.current = next
    setMilestones(next)
    persist(next)
  }, [persist])

  const update = useCallback((id: string, label: string, date: string, emoji?: string, recurring?: boolean) => {
    const next = milestonesRef.current.map(a =>
      a.id === id ? { ...a, label, date, ...(emoji ? { emoji } : {}), ...(recurring !== undefined ? { recurring } : {}) } : a
    )
    mutationVersionRef.current += 1
    milestonesRef.current = next
    setMilestones(next)
    persist(next)
  }, [persist])

  const toggleBadge = useCallback((id: string) => {
    const target = milestonesRef.current.find(a => a.id === id)
    if (!target) return
    if (
      target.showBadge === false
      && milestonesRef.current.filter(a => a.showBadge !== false).length >= MAX_MILESTONE_BADGES
    ) {
      return
    }
    const next = milestonesRef.current.map(a => a.id === id ? { ...a, showBadge: a.showBadge === false ? undefined : false } : a)
    mutationVersionRef.current += 1
    milestonesRef.current = next
    setMilestones(next)
    persist(next)
  }, [persist])

  return { milestones, add, update, remove, toggleBadge }
}
