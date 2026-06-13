import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useAnniversaries } from '../../src/hooks/useAnniversaries'
import { loadAnniversaries, saveAnniversaries } from '../../src/api/driveAnniversaries'

vi.mock('../../src/api/driveAnniversaries', () => ({
  loadAnniversaries: vi.fn(),
  saveAnniversaries: vi.fn(),
  TokenExpiredError: class TokenExpiredError extends Error {},
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(loadAnniversaries).mockResolvedValue([])
  vi.mocked(saveAnniversaries).mockResolvedValue()
})

test('filters malformed local cache entries before rendering', () => {
  localStorage.setItem('linger_anniversaries', JSON.stringify([
    { id: 'valid', label: 'Birthday', date: '2020-05-10' },
    { id: 'bad-date', label: 'Bad', date: '2026-02-30' },
    { id: 'missing-label', date: '2020-05-10' },
  ]))

  const { result } = renderHook(() => useAnniversaries('signedOut', vi.fn()))

  expect(result.current.anniversaries).toEqual([
    { id: 'valid', label: 'Birthday', date: '2020-05-10' },
  ])
})

test('migrates legacy month-day entries from the local cache', () => {
  localStorage.setItem('linger_anniversaries', JSON.stringify([
    { id: 'legacy', label: 'Birthday', monthDay: '05-10' },
    { id: 'leap-day', label: 'Leap day', monthDay: '02-29', showBadge: false },
  ]))

  const { result } = renderHook(() => useAnniversaries('signedOut', vi.fn()))

  expect(result.current.anniversaries).toEqual([
    { id: 'legacy', label: 'Birthday', date: '2000-05-10' },
    { id: 'leap-day', label: 'Leap day', date: '2000-02-29', showBadge: false },
  ])
})

test('limits registrations to ten and enables at most three badges', async () => {
  const { result } = renderHook(() => useAnniversaries('signedOut', vi.fn()))

  act(() => {
    for (let i = 1; i <= 11; i++) {
      result.current.add(`Anniversary ${i}`, `2020-${String(i).padStart(2, '0')}-01`)
    }
  })

  expect(result.current.anniversaries).toHaveLength(10)
  expect(result.current.anniversaries.filter(a => a.showBadge !== false)).toHaveLength(3)
  expect(result.current.anniversaries[3].showBadge).toBe(false)

  act(() => result.current.toggleBadge(result.current.anniversaries[3].id))
  expect(result.current.anniversaries[3].showBadge).toBe(false)

  act(() => {
    result.current.toggleBadge(result.current.anniversaries[0].id)
    result.current.toggleBadge(result.current.anniversaries[3].id)
  })
  expect(result.current.anniversaries.filter(a => a.showBadge !== false)).toHaveLength(3)
  expect(result.current.anniversaries[3].showBadge).toBeUndefined()

  await waitFor(() => expect(saveAnniversaries).toHaveBeenCalledTimes(12))
})

test('serializes saves so an older request cannot finish after a newer one', async () => {
  const firstSave = deferred<void>()
  vi.mocked(saveAnniversaries)
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce()

  const { result } = renderHook(() => useAnniversaries('signedOut', vi.fn()), {
    wrapper: StrictMode,
  })

  act(() => {
    result.current.add('First', '2020-05-10')
    result.current.add('Second', '2021-06-11')
  })

  await waitFor(() => expect(saveAnniversaries).toHaveBeenCalledTimes(1))
  expect(vi.mocked(saveAnniversaries).mock.calls[0][0].map(a => a.label)).toEqual(['First'])

  firstSave.resolve()

  await waitFor(() => expect(saveAnniversaries).toHaveBeenCalledTimes(2))
  expect(vi.mocked(saveAnniversaries).mock.calls[1][0].map(a => a.label)).toEqual(['First', 'Second'])
})

test('does not overwrite a user edit when the initial Drive load finishes late', async () => {
  const load = deferred<Awaited<ReturnType<typeof loadAnniversaries>>>()
  vi.mocked(loadAnniversaries).mockReturnValue(load.promise)

  const { result } = renderHook(() => useAnniversaries('signedIn', vi.fn()))

  act(() => result.current.add('Local edit', '2020-05-10'))
  load.resolve([{ id: 'remote', label: 'Remote old state', date: '2019-01-01' }])

  await act(async () => {
    await load.promise
    await Promise.resolve()
  })

  expect(result.current.anniversaries.map(a => a.label)).toEqual(['Local edit'])
})

test('retries pending local changes before loading Drive state', async () => {
  localStorage.setItem('linger_anniversaries', JSON.stringify([
    { id: 'local', label: 'Pending local', date: '2020-05-10' },
  ]))
  localStorage.setItem('linger_anniversaries_pending', 'true')

  renderHook(() => useAnniversaries('signedIn', vi.fn()))

  await waitFor(() => expect(saveAnniversaries).toHaveBeenCalledWith([
    { id: 'local', label: 'Pending local', date: '2020-05-10' },
  ]))
  expect(loadAnniversaries).not.toHaveBeenCalled()
  await waitFor(() => expect(localStorage.getItem('linger_anniversaries_pending')).toBeNull())
})

test('keeps the pending marker when a save fails', async () => {
  vi.mocked(saveAnniversaries).mockRejectedValueOnce(new Error('offline'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { result } = renderHook(() => useAnniversaries('signedOut', vi.fn()))

  act(() => result.current.add('Offline edit', '2020-05-10'))

  await waitFor(() => expect(saveAnniversaries).toHaveBeenCalledOnce())
  expect(localStorage.getItem('linger_anniversaries_pending')).toBe('true')
})
