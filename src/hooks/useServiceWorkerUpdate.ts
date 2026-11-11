import { useEffect, useRef, useState } from 'react'
import { useLatestRef } from './useEvent'

const BANNER_DELAY = 30 * 60 * 1000

export interface ServiceWorkerUpdateHandle {
  triggerUpdateCheck: () => void
  updatePending: boolean
  dismissUpdate: () => void
}

export function useServiceWorkerUpdate(editorDirty: boolean, sessionActive = false): ServiceWorkerUpdateHandle {
  const regRef = useRef<ServiceWorkerRegistration | null>(null)
  // Reloading discards in-memory credentials as well as unsaved edits.
  const reloadBlocked = useLatestRef(editorDirty || sessionActive)
  const [updatePending, setUpdatePending] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
    const sw = navigator.serviceWorker
    if (!sw) return
    let cancelled = false
    let activating = false
    let reloadReady = false
    let reloaded = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let bannerTimer: ReturnType<typeof setTimeout> | undefined
    const listeners: (() => void)[] = []

    function canReload() {
      return !cancelled && !reloadBlocked.current && document.visibilityState === 'hidden'
    }

    function scheduleBanner() {
      if (bannerTimer) return
      bannerTimer = setTimeout(() => {
        if (!cancelled && regRef.current?.waiting) setUpdatePending(true)
      }, BANNER_DELAY)
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

    function watchRegistration(reg: ServiceWorkerRegistration) {
      if (cancelled) return
      regRef.current = reg
      if (reg.waiting) {
        scheduleBanner()
        maybeApply()
      }
      const onUpdateFound = () => {
        const installing = reg.installing
        if (!installing) return
        const onStateChange = () => {
          if (!cancelled && installing.state === 'installed' && sw.controller) {
            scheduleBanner()
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
      clearTimeout(bannerTimer)
      clearTimeout(fallbackTimer)
    }
  }, [reloadBlocked])

  return {
    triggerUpdateCheck: () => regRef.current?.update(),
    updatePending,
    dismissUpdate: () => setUpdatePending(false),
  }
}
