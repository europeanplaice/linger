import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, __clearEntryStatusSettingsCacheForTests } from '../../functions/api/s3/entry-status/[date]'
import * as s3Settings from '../../functions/_shared/s3Settings'
import * as session from '../../functions/_shared/session'
import * as s3 from '../../functions/_shared/s3'

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  getS3Settings: vi.fn(),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  getValidIdToken: vi.fn().mockResolvedValue('id-token'),
}))

vi.mock('../../functions/_shared/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3')>()),
  assumeRoleWithWebIdentity: vi.fn().mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }),
  headObjectVersion: vi.fn().mockResolvedValue(null),
}))

const enabledSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

const SINCE = '2026-05-01T00:00:00.000Z'

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request(`http://localhost/api/s3/entry-status/2026-05-01?version=5&since=${encodeURIComponent(SINCE)}`),
    params: { date: '2026-05-01' },
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    ...overrides,
  }
}

// Within the endpoint's PENDING_GRACE_MS window after `since` — a fresh save's
// mirror is still plausibly in flight.
function withinGraceWindow() {
  return vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-01T00:00:05.000Z').getTime())
}

// Past the grace window — nothing found an object, an error, or an active
// backfill, so nothing is actually working toward this date any more.
function pastGraceWindow() {
  return vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-01T00:00:25.000Z').getTime())
}

beforeEach(() => {
  vi.clearAllMocks()
  __clearEntryStatusSettingsCacheForTests()
  vi.mocked(s3Settings.getS3Settings).mockResolvedValue(enabledSettings)
  vi.mocked(session.getValidIdToken).mockResolvedValue('id-token')
  vi.mocked(s3.assumeRoleWithWebIdentity).mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' })
  vi.mocked(s3.headObjectVersion).mockResolvedValue(null)
})

describe('GET /api/s3/entry-status/[date]', () => {
  it('rejects an invalid date', async () => {
    const res = await onRequestGet(makeContext({ params: { date: 'not-a-date' } }) as any)
    expect(res.status).toBe(400)
  })

  it('requires a version query param', async () => {
    const res = await onRequestGet(makeContext({
      request: new Request('http://localhost/api/s3/entry-status/2026-05-01'),
    }) as any)
    expect(res.status).toBe(400)
  })

  it('reports disabled when no settings are configured', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(null)

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'disabled' })
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('reports disabled when backup is configured but turned off', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({ ...enabledSettings, enabled: false })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'disabled' })
  })

  it('reports synced when the bucket object version is at least the requested one', async () => {
    vi.mocked(s3.headObjectVersion).mockResolvedValue('5')

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'synced' })
  })

  it('passes a per-account credentials cache key when the session has a decoded google_sub', async () => {
    const res = await onRequestGet(makeContext({ data: { accessToken: 'tok', sessionId: 'sid', session: { google_sub: '112233' } } }) as any)
    await res.json()

    expect(s3.assumeRoleWithWebIdentity).toHaveBeenCalledWith(
      'id-token', enabledSettings.roleArn, enabledSettings.region, `112233:${enabledSettings.roleArn}:${enabledSettings.region}`,
    )
  })

  it('omits the cache key when the session has no google_sub', async () => {
    const res = await onRequestGet(makeContext() as any)
    await res.json()

    expect(s3.assumeRoleWithWebIdentity).toHaveBeenCalledWith('id-token', enabledSettings.roleArn, enabledSettings.region, undefined)
  })

  it('reports pending when the object is behind and the save is still within the grace window', async () => {
    vi.mocked(s3.headObjectVersion).mockResolvedValue('3')
    const dateSpy = withinGraceWindow()

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'pending' })
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('reports unconfirmed once the grace window elapses with the object still missing and nothing else working on it', async () => {
    vi.mocked(s3.headObjectVersion).mockResolvedValue(null)
    const dateSpy = pastGraceWindow()

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'unconfirmed' })
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('reports unconfirmed immediately (no grace window) when the entry is simply opened with no `since`', async () => {
    const res = await onRequestGet(makeContext({
      request: new Request('http://localhost/api/s3/entry-status/2026-05-01?version=5'),
    }) as any)

    expect(await res.json()).toEqual({ status: 'unconfirmed' })
  })

  it('reports failed when a finished backfill explicitly failed on this date, even with no lastSyncErrorAt', async () => {
    // No lastSyncError/lastSyncErrorAt here mirrors recordMirrorSuccess clearing them
    // after some unrelated later save succeeded, without touching backfillProgress —
    // the exact gap this check exists to cover.
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 10, failed: ['2026-05-01'], finishedAt: '2026-05-01T00:00:05.000Z' },
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'Backfill failed for this entry — retry from Settings.' })
  })

  it('reports pending (within grace window) when a finished backfillProgress lists a different date as failed', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 10, failed: ['2026-05-02'], finishedAt: '2026-05-01T00:00:05.000Z' },
    })
    const dateSpy = withinGraceWindow()

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'pending' })
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('reports backfilling when backfill is still running (not finished), even if this date is currently in the failed list', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: ['2026-05-01'] },
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'backfilling' })
  })

  it('keeps reporting backfilling regardless of elapsed time since the save, so the client keeps polling', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: [] },
    })
    const dateSpy = pastGraceWindow()

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'backfilling' })
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('reports backfilling — not a stale failed error — for an untouched date opened mid-backfill', async () => {
    // Regression test: a stale lastSyncError/lastSyncErrorAt from a previous run used
    // to outrank an actively-running backfill whenever the poll had no `since` (e.g.
    // simply opening an untouched entry mid-run), wrongly surfacing 'failed' with a
    // tap-to-retry affordance that — before resyncSingleEntry existed — could even
    // clobber the running backfill if tapped. The active run is a stronger, more
    // specific "still working on it" signal and must win.
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: [] },
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-04-30T00:00:00.000Z',
    })

    const res = await onRequestGet(makeContext({
      request: new Request('http://localhost/api/s3/entry-status/2026-05-01?version=5'),
    }) as any)

    expect(await res.json()).toEqual({ status: 'backfilling' })
  })

  it('still reports failed (not backfilling) when the STS/S3 check itself fails, even during an active backfill', async () => {
    vi.mocked(s3.assumeRoleWithWebIdentity).mockRejectedValue(new Error('network blip'))
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: [] },
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'network blip' })
  })

  it('still reports failed when this exact save is scoped after a fresh error recorded during an active backfill', async () => {
    // A save's own since-scoped check must still see its own fresh failure even if an
    // unrelated backfill happens to be running at the same time.
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: [] },
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-05-01T00:00:05.000Z', // after SINCE
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'AccessDenied' })
  })

  it('reports failed when a sync error was recorded after the save attempt started', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-05-01T00:00:05.000Z',
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'AccessDenied' })
  })

  it('does not misattribute a stale sync error recorded before the save attempt started (falls through to pending within the grace window)', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-04-30T00:00:00.000Z',
    })
    const dateSpy = withinGraceWindow()

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'pending' })
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('reports failed (re-auth needed) without calling AWS when there is no valid Google ID token and no error is already recorded', async () => {
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({
      status: 'failed',
      error: 'No Google ID token in this session — sign out and sign in again',
    })
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('surfaces an already-recorded sync error instead of the generic no-token message when there is no valid Google ID token', async () => {
    // Regression guard: the no-ID-token case used to short-circuit to 'pending'
    // before the backfillProgress.failed / lastSyncErrorAt checks ever ran,
    // silently swallowing an already-recorded failure.
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-05-01T00:00:05.000Z',
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'AccessDenied' })
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('reports failed when the STS/S3 call fails and no sync error was recorded', async () => {
    vi.mocked(s3.assumeRoleWithWebIdentity).mockRejectedValue(new Error('network blip'))

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'network blip' })
  })

  it('reports failed when STS fails with InvalidIdentityToken and no other error is recorded', async () => {
    vi.mocked(s3.assumeRoleWithWebIdentity).mockRejectedValue(
      new Error('STS AssumeRoleWithWebIdentity failed: {"Error":{"Code":"InvalidIdentityToken","Message":"The web identity token provided could not be validated."}}')
    )

    const res = await onRequestGet(makeContext() as any)

    const body = await res.json() as { status: string; error: string }
    expect(body.status).toBe('failed')
    expect(body.error).toContain('InvalidIdentityToken')
  })

  it('reports failed when the AWS call fails unexpectedly but a sync error was recorded after the save attempt started', async () => {
    vi.mocked(s3.assumeRoleWithWebIdentity).mockRejectedValue(new Error('STS failed'))
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-05-01T00:00:05.000Z',
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'failed', error: 'AccessDenied' })
  })

  it('reports failed for persistent errors after the elapsed threshold even if the error timestamp is before the save started', async () => {
    // Save started at 2026-05-01T00:00:00.000Z (SINCE)
    // Error was recorded before that, at 2026-04-30T00:00:00.000Z
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-04-30T00:00:00.000Z',
    })

    // Current time is 10 seconds after the save started (2026-05-01T00:00:10.000Z)
    const mockNow = new Date('2026-05-01T00:00:10.000Z').getTime()
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(mockNow)

    try {
      const res = await onRequestGet(makeContext() as any)
      expect(await res.json()).toEqual({ status: 'failed', error: 'AccessDenied' })
    } finally {
      dateSpy.mockRestore()
    }
  })
})

describe('GET /api/s3/entry-status/[date] — settings lookup caching', () => {
  // A save schedules up to 7 poll attempts (S3_POLL_DELAYS_MS in EntryEditor.tsx),
  // each of which used to call getS3Settings — and thus loadS3SettingsRecord's Drive
  // reads — independently. Caching the settings lookup briefly (module-scope, keyed
  // by session, read-only-path-only) cuts that down without affecting the actual
  // "has it landed" signal, which is always the live headObjectVersion check below.
  it('reuses a cached settings lookup across polls for the same session within the TTL', async () => {
    await (await onRequestGet(makeContext() as any)).json()
    await (await onRequestGet(makeContext() as any)).json()

    expect(s3Settings.getS3Settings).toHaveBeenCalledTimes(1)
    // The live "has it landed" check is never cached — every poll still checks S3 directly.
    expect(s3.headObjectVersion).toHaveBeenCalledTimes(2)
  })

  it('re-fetches settings once the cache entry has expired', async () => {
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-01T00:00:00.000Z').getTime())
    try {
      await (await onRequestGet(makeContext() as any)).json()
      dateSpy.mockReturnValue(new Date('2026-05-01T00:00:06.000Z').getTime()) // past a short TTL
      await (await onRequestGet(makeContext() as any)).json()

      expect(s3Settings.getS3Settings).toHaveBeenCalledTimes(2)
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('keys the cache per session, so one account never sees another account\'s cached settings', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValueOnce(enabledSettings)
    vi.mocked(s3Settings.getS3Settings).mockResolvedValueOnce({ ...enabledSettings, enabled: false })

    await (await onRequestGet(makeContext() as any)).json()
    const res2 = await onRequestGet(makeContext({ data: { accessToken: 'tok2', sessionId: 'sid-2', session: {} } }) as any)

    expect(await res2.json()).toEqual({ status: 'disabled' })
    expect(s3Settings.getS3Settings).toHaveBeenCalledTimes(2)
  })
})
