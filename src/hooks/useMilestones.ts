import { useState, useEffect, useCallback, useRef } from 'react'
import { MAX_MILESTONES, MAX_MILESTONE_BADGES, normalizeMilestones, type Milestone } from '../types'
import { loadMilestones, saveMilestones, TokenExpiredError } from '../api/driveMilestones'
import { SecureLocalData } from '../lib/secureLocalData'
import { captureLocalContext } from '../lib/secureLocalContext'
import { useLatestRef } from './useEvent'

const STORAGE_KEY = 'linger_milestones'
const PENDING_STORAGE_KEY = 'linger_milestones_pending'
interface LocalMilestones { list: Milestone[]; pending: boolean; changeId: string }
const records = new SecureLocalData<LocalMilestones>('milestones')

export async function hasPendingMilestones(): Promise<boolean> {
  // An unattributed legacy change must never be discarded by folder changes.
  if (localStorage.getItem(PENDING_STORAGE_KEY) === 'true') return true
  return (await records.get('list'))?.pending ?? false
}

function hasLegacy(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
}

let nextId = 1
function generateId(): string {
  try { return crypto.randomUUID() } catch { return String(Date.now()) + String(nextId++) }
}

export function useMilestones(authStatus: string, onTokenExpired: () => void, owner: string | null = null) {
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState(false)
  const [syncError, setSyncError] = useState(false)
  const [legacyAvailable, setLegacyAvailable] = useState(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const milestonesRef = useRef<Milestone[]>([])
  const readyRef = useRef(false)
  const changeIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const mutationVersionRef = useRef(0)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const driveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const failedRef = useRef(false)
  const onTokenExpiredRef = useLatestRef(onTokenExpired)

  const persist = useCallback((next: Milestone[], afterPersist?: () => void) => {
    const generation = generationRef.current
    const changeId = generateId()
    const saved = queueRef.current.then(async () => {
      if (generation !== generationRef.current || failedRef.current) throw new Error('Milestone session changed or local save failed')
      const state = captureLocalContext(owner ?? undefined)
      await records.update('list', current => {
        if ((current?.changeId ?? null) !== changeIdRef.current) throw new Error('Milestones changed in another tab')
        return { list: next, pending: true, changeId }
      })
      state.assertCurrent()
      if (generation !== generationRef.current) return
      changeIdRef.current = changeId
      afterPersist?.()
      driveQueueRef.current = driveQueueRef.current.catch(() => {}).then(async () => {
        try {
          if (!navigator.locks) throw new Error('Cross-tab locking unavailable')
          await navigator.locks.request(`linger-milestones:${state.userId}`, async () => {
            state.assertCurrent()
            if (generation !== generationRef.current) return
            const current = await records.get('list')
            if (!current || current.changeId !== changeId) return
            await saveMilestones(next)
            state.assertCurrent()
            await records.update('list', latest => {
              if (!latest) throw new Error('Milestone record disappeared')
              return latest.changeId === changeId ? { ...latest, pending: false } : latest
            })
            if (generation === generationRef.current) setSyncError(false)
          })
        } catch (error) {
          if (error instanceof TokenExpiredError) onTokenExpiredRef.current()
          if (generation === generationRef.current) setSyncError(true)
          // The encrypted pending copy remains for the next sign-in or retry.
        }
      })
    })
    queueRef.current = saved.catch(error => {
      if (generation === generationRef.current) {
        failedRef.current = true
        setStorageError(true)
        console.error('Unable to save encrypted milestones:', error)
      }
    })
  }, [owner, onTokenExpiredRef])

  useEffect(() => {
    const generation = ++generationRef.current
    readyRef.current = false
    failedRef.current = false
    changeIdRef.current = null
    queueRef.current = Promise.resolve()
    driveQueueRef.current = Promise.resolve()
    milestonesRef.current = []
    setMilestones([])
    setReady(false)
    setStorageError(false)
    setSyncError(false)
    setLegacyAvailable(false)
    setRecoveryReady(false)
    if (authStatus !== 'signedIn' || !owner) return
    void (async () => {
      try {
        const state = captureLocalContext(owner)
        const local = await records.get('list')
        state.assertCurrent()
        if (generation !== generationRef.current) return
        if (local) {
          if (!Array.isArray(local.list) || typeof local.pending !== 'boolean' || typeof local.changeId !== 'string') throw new Error('Invalid encrypted milestones')
          const list = normalizeMilestones(local.list)
          milestonesRef.current = list
          setMilestones(list)
          changeIdRef.current = local.changeId
        }
        setLegacyAvailable(hasLegacy())
        if (local?.pending) {
          readyRef.current = true
          setReady(true)
          persist(normalizeMilestones(local.list))
          return
        }
        const loadVersion = mutationVersionRef.current
        const remote = await loadMilestones().catch(error => {
          if (error instanceof TokenExpiredError) onTokenExpiredRef.current()
          if (generation === generationRef.current) setSyncError(true)
          return null
        })
        if (remote !== null) {
          state.assertCurrent()
          if (generation !== generationRef.current || mutationVersionRef.current !== loadVersion) return
          // Cache a remote snapshot only if no other tab changed the local state.
          const changeId = generateId()
          await records.update('list', current => {
            if ((current?.changeId ?? null) !== changeIdRef.current) throw new Error('Milestones changed in another tab')
            return { list: remote, pending: false, changeId }
          })
          state.assertCurrent()
          if (generation !== generationRef.current || mutationVersionRef.current !== loadVersion) return
          changeIdRef.current = changeId
          milestonesRef.current = remote
          setMilestones(remote)
          setRecoveryReady(true)
        }
        if (generation === generationRef.current && (local || changeIdRef.current)) {
          readyRef.current = true
          setReady(true)
        }
      } catch (error) {
        if (generation === generationRef.current) {
          setStorageError(true)
          console.error('Unable to open encrypted milestones:', error)
        }
      }
    })()
    return () => { if (generationRef.current === generation) generationRef.current++ }
  }, [authStatus, owner, onTokenExpiredRef, persist])

  const mutate = useCallback((makeNext: (current: Milestone[]) => Milestone[]) => {
    if (!readyRef.current || failedRef.current) { setStorageError(true); return }
    const next = makeNext(milestonesRef.current)
    if (next === milestonesRef.current) return
    mutationVersionRef.current++
    milestonesRef.current = next
    setMilestones(next)
    persist(next)
  }, [persist])

  const add = useCallback((label: string, date: string, emoji?: string, recurring?: boolean) => {
    mutate(current => {
      if (current.length >= MAX_MILESTONES) return current
      const enabled = current.filter(a => a.showBadge !== false).length
      return [...current, { id: generateId(), label, date,
        ...(enabled >= MAX_MILESTONE_BADGES ? { showBadge: false } : {}),
        ...(emoji ? { emoji } : {}), ...(recurring !== undefined ? { recurring } : {}) }]
    })
  }, [mutate])
  const remove = useCallback((id: string) => mutate(current => current.filter(a => a.id !== id)), [mutate])
  const update = useCallback((id: string, label: string, date: string, emoji?: string, recurring?: boolean) => {
    mutate(current => current.map(a => a.id === id ? { ...a, label, date, ...(emoji ? { emoji } : {}), ...(recurring !== undefined ? { recurring } : {}) } : a))
  }, [mutate])
  const toggleBadge = useCallback((id: string) => {
    mutate(current => {
      const target = current.find(a => a.id === id)
      if (!target || (target.showBadge === false && current.filter(a => a.showBadge !== false).length >= MAX_MILESTONE_BADGES)) return current
      return current.map(a => a.id === id ? { ...a, showBadge: a.showBadge === false ? undefined : false } : a)
    })
  }, [mutate])

  // The previous format had no account identity. Import only after the user
  // explicitly chooses to merge it into the currently unlocked account.
  const recoverLegacy = useCallback(() => {
    if (!readyRef.current || failedRef.current || !recoveryReady) { setStorageError(true); return }
    const raw = localStorage.getItem(STORAGE_KEY)
    const pending = localStorage.getItem(PENDING_STORAGE_KEY)
    if (raw === null) { setLegacyAvailable(false); return }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('Invalid legacy milestones')
      const legacy = normalizeMilestones(parsed)
      if (legacy.length !== parsed.length) throw new Error('Some legacy milestones require manual recovery')
      const current = milestonesRef.current
      const byId = new Map(current.map(item => [item.id, item]))
      for (const item of legacy) {
        const previous = byId.get(item.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Conflicting legacy milestone')
        byId.set(item.id, item)
      }
      const next = [...byId.values()]
      if (next.length > MAX_MILESTONES) throw new Error('Too many milestones to restore')
      mutationVersionRef.current++
      milestonesRef.current = next
      setMilestones(next)
      persist(next, () => {
        if (localStorage.getItem(STORAGE_KEY) === raw && localStorage.getItem(PENDING_STORAGE_KEY) === pending) {
          localStorage.removeItem(STORAGE_KEY)
          localStorage.removeItem(PENDING_STORAGE_KEY)
          setLegacyAvailable(false)
        }
      })
    } catch { setStorageError(true) }
  }, [persist, recoveryReady])

  const waitForLocalChanges = useCallback(async () => {
    await queueRef.current
    if (failedRef.current) throw new Error('Milestone changes were not saved locally')
  }, [])

  return { milestones, ready, storageError, syncError, legacyAvailable, recoveryReady, recoverLegacy, waitForLocalChanges, add, update, remove, toggleBadge }
}
