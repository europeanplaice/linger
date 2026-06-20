import { useEffect, useRef } from 'react'

export function useDeployVersionCheck(onMismatch: () => void): void {
  const onMismatchRef = useRef(onMismatch)
  const notifiedRef = useRef(false)

  useEffect(() => {
    onMismatchRef.current = onMismatch
  }, [onMismatch])

  useEffect(() => {
    if (import.meta.env.DEV) return

    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (!notifiedRef.current) {
        const serverVersion = response.headers.get('X-Deploy-Version')
        if (serverVersion && serverVersion !== __DEPLOY_VERSION__) {
          notifiedRef.current = true
          onMismatchRef.current()
        }
      }
      return response
    }
    return () => {
      window.fetch = original
    }
  }, [])
}
