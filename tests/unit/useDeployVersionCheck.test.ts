import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeployVersionCheck } from '../../src/hooks/useDeployVersionCheck'

const CURRENT_VERSION = 'test-version'
const STALE_VERSION = 'old-version'

function makeResponse(deployVersion: string | null, body = '{}') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deployVersion !== null) headers['X-Deploy-Version'] = deployVersion
  return Promise.resolve(new Response(body, { headers }))
}

let originalFetch: typeof fetch
let originalDEV: boolean

beforeEach(() => {
  originalFetch = window.fetch
  originalDEV = import.meta.env.DEV
  ;(import.meta.env as Record<string, unknown>).DEV = false
})

afterEach(() => {
  window.fetch = originalFetch
  ;(import.meta.env as Record<string, unknown>).DEV = originalDEV
  vi.restoreAllMocks()
})

describe('useDeployVersionCheck', () => {
  it('calls onMismatch when server version differs from build version', async () => {
    const onMismatch = vi.fn()
    window.fetch = vi.fn(() => makeResponse(STALE_VERSION))

    renderHook(() => useDeployVersionCheck(onMismatch))
    await act(async () => { await window.fetch('/api/drive/list') })

    expect(onMismatch).toHaveBeenCalledTimes(1)
  })

  it('does not call onMismatch when server version matches build version', async () => {
    const onMismatch = vi.fn()
    window.fetch = vi.fn(() => makeResponse(CURRENT_VERSION))

    renderHook(() => useDeployVersionCheck(onMismatch))
    await act(async () => { await window.fetch('/api/drive/list') })

    expect(onMismatch).not.toHaveBeenCalled()
  })

  it('does not call onMismatch when response has no version header', async () => {
    const onMismatch = vi.fn()
    window.fetch = vi.fn(() => makeResponse(null))

    renderHook(() => useDeployVersionCheck(onMismatch))
    await act(async () => { await window.fetch('/api/drive/list') })

    expect(onMismatch).not.toHaveBeenCalled()
  })

  it('calls onMismatch only once even when multiple mismatching fetches occur', async () => {
    const onMismatch = vi.fn()
    window.fetch = vi.fn(() => makeResponse(STALE_VERSION))

    renderHook(() => useDeployVersionCheck(onMismatch))
    await act(async () => {
      await window.fetch('/api/drive/list')
      await window.fetch('/api/drive/list')
      await window.fetch('/api/drive/list')
    })

    expect(onMismatch).toHaveBeenCalledTimes(1)
  })

  it('restores original fetch on unmount', async () => {
    const onMismatch = vi.fn()
    const savedFetch = vi.fn(() => makeResponse(STALE_VERSION))
    window.fetch = savedFetch

    const { unmount } = renderHook(() => useDeployVersionCheck(onMismatch))
    unmount()

    expect(window.fetch).toBe(savedFetch)
  })

  it('does not wrap fetch in DEV mode', async () => {
    ;(import.meta.env as Record<string, unknown>).DEV = true
    const onMismatch = vi.fn()
    const originalFetchSpy = vi.fn(() => makeResponse(STALE_VERSION))
    window.fetch = originalFetchSpy

    renderHook(() => useDeployVersionCheck(onMismatch))

    // fetch should remain the same reference (not wrapped)
    expect(window.fetch).toBe(originalFetchSpy)
    expect(onMismatch).not.toHaveBeenCalled()
  })

  it('still returns the fetch response unchanged', async () => {
    const onMismatch = vi.fn()
    window.fetch = vi.fn(() => makeResponse(STALE_VERSION, '{"ok":true}'))

    renderHook(() => useDeployVersionCheck(onMismatch))
    let res!: Response
    await act(async () => { res = await window.fetch('/api/drive/list') })

    expect(await res.json()).toEqual({ ok: true })
  })
})
