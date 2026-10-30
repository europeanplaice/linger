import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deleteEntry, listEntries, saveEntry } from '../../src/api/driveEntries'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const operations = [
  { name: 'save', run: (signal: AbortSignal) => saveEntry('2026-05-01', { date: '2026-05-01', content: 'account A secret' }, { signal }) },
  { name: 'delete', run: (signal: AbortSignal) => deleteEntry('2026-05-01', signal) },
  { name: 'list', run: (signal: AbortSignal) => listEntries(signal) },
]

it.each(operations)('cancels $name retry rather than sending the old request with a new session', async ({ run }) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('temporary failure', { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  const pending = run(controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
  // The cookie could now belong to another account. There must be no retry.
  controller.abort()
  await rejected
  await vi.runAllTimersAsync()
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(operations)('does not dispatch an already-cancelled $name request', async ({ run }) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  controller.abort()
  await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchMock).not.toHaveBeenCalled()
})
