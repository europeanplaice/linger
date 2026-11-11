import { useEffect, useRef, useState } from 'react'
import { useLatestRef } from './useEvent'

export interface ServiceWorkerUpdateHandle {
  triggerUpdateCheck: () => void
  updatePending: boolean
  dismissUpdate: () => void
  applyUpdate: () => void
}

export function useServiceWorkerUpdate(editorDirty: boolean, sessionActive = false): ServiceWorkerUpdateHandle {
  const regRef = useRef<ServiceWorkerRegistration | null>(null)
  // Reloading discards in-memory credentials as well as unsaved edits.
  const reloadBlocked = useLatestRef(editorDirty || sessionActive)
  const editorDirtyRef = useLatestRef(editorDirty)
  const [updatePending, setUpdatePending] = useState(false)
  const applyUpdateRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
    const sw = navigator.serviceWorker
    if (!sw) return
    let cancelled = false
    let activating = false
    let reloadReady = false
    let reloaded = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let manualUpdate = false
    const listeners: (() => void)[] = []

    function canReload() {
      return !cancelled && (manualUpdate ? !editorDirtyRef.current : !reloadBlocked.current && document.visibilityState === 'hidden')
    }

    function finishActivation() {
      reloadReady = true
      clearTimeout(fallbackTimer)
      // Activation may finish after the user returned, started typing, or
      // signed in. Keep the update ready for a later safe opportunity.
      if (!canReload() || reloaded) return
      reloaded = true
      window.location.reload()
    }

    function maybeApply() {
      if (!canReload() || reloaded) return
      if (reloadReady) { finishActivation(); return }
      if (activating) return
      const waiting = regRef.current?.waiting
      if (!waiting) return
      activating = true
      fallbackTimer = setTimeout(finishActivation, 4000)
      sw.addEventListener('controllerchange', finishActivation, { once: true })
      listeners.push(() => sw.removeEventListener('controllerchange', finishActivation))
      waiting.postMessage('SKIP_WAITING')
    }

    applyUpdateRef.current = () => {
      if (editorDirtyRef.current) return
      manualUpdate = true
      maybeApply()
    }

    function watchRegistration(reg: ServiceWorkerRegistration) {
      if (cancelled) return
      regRef.current = reg
      if (reg.waiting) {
        setUpdatePending(true)
        maybeApply()
      }
      const onUpdateFound = () => {
        const installing = reg.installing
        if (!installing) return
        const onStateChange = () => {
          if (!cancelled && installing.state === 'installed' && sw.controller) {
            setUpdatePending(true)
            maybeApply()
          }
        }
        installing.addEventListener('statechange', onStateChange)
        listeners.push(() => installing.removeEventListener('statechange', onStateChange))
      }
      reg.addEventListener('updatefound', onUpdateFound)
      listeners.push(() => reg.removeEventListener('updatefound', onUpdateFound))
    }

    sw.ready.then(watchRegistration)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        regRef.current?.update()
      } else {
        maybeApply()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cancelled = true
      regRef.current = null
      document.removeEventListener('visibilitychange', handleVisibility)
      listeners.forEach(remove => remove())
      applyUpdateRef.current = () => {}
      clearTimeout(fallbackTimer)
    }
  }, [reloadBlocked, editorDirtyRef])

  return {
    triggerUpdateCheck: () => regRef.current?.update(),
    updatePending,
    dismissUpdate: () => setUpdatePending(false),
    applyUpdate: () => applyUpdateRef.current(),
  }
}
