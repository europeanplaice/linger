import { useRef, useState, useCallback } from 'react'

const STORAGE_KEY = 'gp-save-timings'
const MAX_SAMPLES = 10
const DEFAULT_DURATION = 4000

function getTimings(): number[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

function recordTiming(ms: number) {
  const timings = getTimings()
  timings.push(ms)
  if (timings.length > MAX_SAMPLES) timings.shift()
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(timings)) } catch {
    // Ignore storage write failures; save progress should remain best-effort.
  }
}

function getEstimate(): number {
  const t = getTimings()
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : DEFAULT_DURATION
}

export function useSaveProgress() {
  const [progress, setProgress] = useState<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef(0)
  const startTimeRef = useRef(0)
  const estimateRef = useRef(DEFAULT_DURATION)

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startSave = useCallback(() => {
    stop()
    estimateRef.current = getEstimate()
    startTimeRef.current = performance.now()
    lastTickRef.current = 0
    setProgress(0)

    const tick = (now: number) => {
      const elapsed = now - startTimeRef.current
      const p = Math.min(elapsed / estimateRef.current, 1) * 0.9

      if (now - lastTickRef.current >= 50) {
        lastTickRef.current = now
        setProgress(p)
      }

      if (p < 0.9) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setProgress(0.9)
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stop])

  const completeSave = useCallback((success: boolean) => {
    stop()
    if (success) recordTiming(performance.now() - startTimeRef.current)
    setProgress(1)
    setTimeout(() => setProgress(null), 600)
  }, [stop])

  return { progress, startSave, completeSave }
}
