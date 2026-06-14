import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMilestones } from '../../src/hooks/useMilestones'
import { loadMilestones, saveMilestones } from '../../src/api/driveMilestones'

vi.mock('../../src/api/driveMilestones', () => ({
  loadMilestones: vi.fn(),
  saveMilestones: vi.fn(),
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
  vi.mocked(loadMilestones).mockResolvedValue([])
  vi.mocked(saveMilestones).mockResolvedValue()
})

test('filters malformed local cache entries before rendering', () => {
  localStorage.setItem('linger_milestones', JSON.stringify([
    { id: 'valid', label: 'Birthday', date: '2020-05-10' },
    { id: 'bad-date', label: 'Bad', date: '2026-02-30' },
    { id: 'missing-label', date: '2020-05-10' },
  ]))

  const { result } = renderHook(() => useMilestones('signedOut', vi.fn()))

  expect(result.current.milestones).toEqual([
    { id: 'valid', label: 'Birthday', date: '2020-05-10' },
  ])
})

test('migrates legacy month-day entries from the local cache', () => {
  localStorage.setItem('linger_milestones', JSON.stringify([
    { id: 'legacy', label: 'Birthday', monthDay: '05-10' },
    { id: 'leap-day', label: 'Leap day', monthDay: '02-29', showBadge: false },
  ]))

  const { result } = renderHook(() => useMilestones('signedOut', vi.fn()))

  expect(result.current.milestones).toEqual([
    { id: 'legacy', label: 'Birthday', date: '2000-05-10' },
    { id: 'leap-day', label: 'Leap day', date: '2000-02-29', showBadge: false },
  ])
})

test('limits registrations to ten and enables at most three badges', async () => {
  const { result } = renderHook(() => useMilestones('signedOut', vi.fn()))

  act(() => {
    for (let i = 1; i <= 11; i++) {
      result.current.add(`Milestone ${i}`, `2020-${String(i).padStart(2, '0')}-01`)
    }
  })

  expect(result.current.milestones).toHaveLength(10)
  expect(result.current.milestones.filter(a => a.showBadge !== false)).toHaveLength(3)
  expect(result.current.milestones[3].showBadge).toBe(false)

  act(() => result.current.toggleBadge(result.current.milestones[3].id))
  expect(result.current.milestones[3].showBadge).toBe(false)

  act(() => {
    result.current.toggleBadge(result.current.milestones[0].id)
    result.current.toggleBadge(result.current.milestones[3].id)
  })
  expect(result.current.milestones.filter(a => a.showBadge !== false)).toHaveLength(3)
  expect(result.current.milestones[3].showBadge).toBeUndefined()

  await waitFor(() => expect(saveMilestones).toHaveBeenCalledTimes(12))
})

test('serializes saves so an older request cannot finish after a newer one', async () => {
  const firstSave = deferred<void>()
  vi.mocked(saveMilestones)
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce()

  const { result } = renderHook(() => useMilestones('signedOut', vi.fn()), {
    wrapper: StrictMode,
  })

  act(() => {
    result.current.add('First', '2020-05-10')
    result.current.add('Second', '2021-06-11')
  })

  await waitFor(() => expect(saveMilestones).toHaveBeenCalledTimes(1))
  expect(vi.mocked(saveMilestones).mock.calls[0][0].map(a => a.label)).toEqual(['First'])

  firstSave.resolve()

  await waitFor(() => expect(saveMilestones).toHaveBeenCalledTimes(2))
  expect(vi.mocked(saveMilestones).mock.calls[1][0].map(a => a.label)).toEqual(['First', 'Second'])
})

test('does not overwrite a user edit when the initial Drive load finishes late', async () => {
  const load = deferred<Awaited<ReturnType<typeof loadMilestones>>>()
  vi.mocked(loadMilestones).mockReturnValue(load.promise)

  const { result } = renderHook(() => useMilestones('signedIn', vi.fn()))

  act(() => result.current.add('Local edit', '2020-05-10'))
  load.resolve([{ id: 'remote', label: 'Remote old state', date: '2019-01-01' }])

  await act(async () => {
    await load.promise
    await Promise.resolve()
  })

  expect(result.current.milestones.map(a => a.label)).toEqual(['Local edit'])
})

test('retries pending local changes before loading Drive state', async () => {
  localStorage.setItem('linger_milestones', JSON.stringify([
    { id: 'local', label: 'Pending local', date: '2020-05-10' },
  ]))
  localStorage.setItem('linger_milestones_pending', 'true')

  renderHook(() => useMilestones('signedIn', vi.fn()))

  await waitFor(() => expect(saveMilestones).toHaveBeenCalledWith([
    { id: 'local', label: 'Pending local', date: '2020-05-10' },
  ]))
  expect(loadMilestones).not.toHaveBeenCalled()
  await waitFor(() => expect(localStorage.getItem('linger_milestones_pending')).toBeNull())
})

test('keeps the pending marker when a save fails', async () => {
  vi.mocked(saveMilestones).mockRejectedValueOnce(new Error('offline'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { result } = renderHook(() => useMilestones('signedOut', vi.fn()))

  act(() => result.current.add('Offline edit', '2020-05-10'))

  await waitFor(() => expect(saveMilestones).toHaveBeenCalledOnce())
  expect(localStorage.getItem('linger_milestones_pending')).toBe('true')
})
