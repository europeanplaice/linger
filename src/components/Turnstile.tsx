import { useEffect, useRef, useState } from 'react'

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (id: string) => void
  reset: (id: string) => void
}
declare global { interface Window { turnstile?: TurnstileApi } }

let loading: Promise<TurnstileApi> | undefined
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable'))
      script.onerror = () => reject(new Error('Turnstile unavailable'))
      document.head.appendChild(script)
    }).catch(error => { loading = undefined; throw error })
  }
  return loading!
}

export function Turnstile({ action, onToken, resetKey, language }: { action: 'login' | 'register'; onToken: (token: string) => void; resetKey: number; language: string }) {
  const element = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const callback = useRef(onToken)
  callback.current = onToken
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let api: TurnstileApi | undefined
    void loadTurnstile().then(instance => {
      if (!active || !element.current) return
      api = instance
      widget.current = instance.render(element.current, {
        sitekey: '0x4AAAAAAGBh2FPKQPWYBSp1', action,
        callback: (token: string) => callback.current(token),
        'expired-callback': () => callback.current(''),
        'error-callback': () => { callback.current(''); setFailed(true) },
      })
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (widget.current && api) api.remove(widget.current); widget.current = null; callback.current('') }
  }, [action])
  useEffect(() => { if (resetKey && widget.current) window.turnstile?.reset(widget.current) }, [resetKey])
  return <><div ref={element} />{failed && <p role="alert">{language === 'ja' ? '認証を読み込めませんでした。ページを再読み込みしてください。' : 'Verification could not load. Please reload the page.'}</p>}</>
}
