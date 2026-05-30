import { useEffect, useRef } from 'react'

export function useServiceWorkerUpdate(editorDirty: boolean): void {
  const regRef = useRef<ServiceWorkerRegistration | null>(null)
  const dirtyRef = useRef(editorDirty)
  const reloadingRef = useRef(false)

  function maybeApply() {
    if (reloadingRef.current || dirtyRef.current) return
    const waiting = regRef.current?.waiting
    if (!waiting) return
    reloadingRef.current = true
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => window.location.reload(),
      { once: true },
    )
    // Fallback: if controllerchange never fires, reload after 4s so the app doesn't
    // get stuck with reloadingRef=true and stale assets served forever.
    setTimeout(() => window.location.reload(), 4000)
    waiting.postMessage('SKIP_WAITING')
  }

  useEffect(() => {
    dirtyRef.current = editorDirty
    if (!editorDirty) maybeApply()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorDirty])

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
    const sw = navigator.serviceWorker
    if (!sw) return

    function watchRegistration(reg: ServiceWorkerRegistration) {
      regRef.current = reg
      if (reg.waiting) maybeApply()
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && sw.controller) maybeApply()
        })
      })
    }

    sw.ready.then(watchRegistration)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        regRef.current?.update()
        maybeApply()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
