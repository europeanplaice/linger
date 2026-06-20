import { useEffect, useRef, useState } from 'react'

const BANNER_DELAY = 30 * 60 * 1000

export interface ServiceWorkerUpdateHandle {
  triggerUpdateCheck: () => void
  updatePending: boolean
  dismissUpdate: () => void
}

export function useServiceWorkerUpdate(editorDirty: boolean): ServiceWorkerUpdateHandle {
  const regRef = useRef<ServiceWorkerRegistration | null>(null)
  const dirtyRef = useRef(editorDirty)
  const reloadingRef = useRef(false)
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)
  const [updatePending, setUpdatePending] = useState(false)

  function scheduleBanner() {
    if (bannerTimerRef.current) return
    bannerTimerRef.current = setTimeout(() => {
      if (!cancelledRef.current && regRef.current?.waiting) setUpdatePending(true)
    }, BANNER_DELAY)
  }

  function maybeApply() {
    if (reloadingRef.current || dirtyRef.current) return
    const waiting = regRef.current?.waiting
    if (!waiting) return
    reloadingRef.current = true
    const fallbackTimer = setTimeout(() => window.location.reload(), 4000)
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(fallbackTimer)
        window.location.reload()
      },
      { once: true },
    )
    waiting.postMessage('SKIP_WAITING')
  }

  useEffect(() => {
    dirtyRef.current = editorDirty
    // Intentionally no maybeApply() here — updates apply only when the tab
    // is hidden so the user is never interrupted mid-session.
  }, [editorDirty])

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
    const sw = navigator.serviceWorker
    if (!sw) return

    function watchRegistration(reg: ServiceWorkerRegistration) {
      if (cancelledRef.current) return
      regRef.current = reg
      if (reg.waiting) {
        scheduleBanner()
        maybeApply()
      }
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && sw.controller) {
            scheduleBanner()
            maybeApply()
          }
        })
      })
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
      cancelledRef.current = true
      document.removeEventListener('visibilitychange', handleVisibility)
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    triggerUpdateCheck: () => regRef.current?.update(),
    updatePending,
    dismissUpdate: () => setUpdatePending(false),
  }
}
