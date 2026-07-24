import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from '../../functions/api/s3/entry-status/[date]'
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

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/s3/entry-status/2026-05-01?version=5&since=2026-05-01T00%3A00%3A00.000Z'),
    params: { date: '2026-05-01' },
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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

  it('reports pending when the object is behind and there is no recent sync error', async () => {
    vi.mocked(s3.headObjectVersion).mockResolvedValue('3')

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('reports pending when the object does not exist yet', async () => {
    vi.mocked(s3.headObjectVersion).mockResolvedValue(null)

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
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

  it('reports pending when backfillProgress lists a different date as failed', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 10, failed: ['2026-05-02'], finishedAt: '2026-05-01T00:00:05.000Z' },
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('reports pending when backfill is still running (not finished) even if this date is currently in the failed list', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      backfillProgress: { total: 10, done: 4, failed: ['2026-05-01'] },
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
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

  it('does not misattribute a stale sync error recorded before the save attempt started', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({
      ...enabledSettings,
      lastSyncError: 'AccessDenied',
      lastSyncErrorAt: '2026-04-30T00:00:00.000Z',
    })

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('reports pending without calling AWS when there is no valid Google ID token', async () => {
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)

    const res = await onRequestGet(makeContext() as any)

    expect(await res.json()).toEqual({ status: 'pending' })
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
    // Save started at 2026-05-01T00:00:00.000Z (set in makeContext)
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
