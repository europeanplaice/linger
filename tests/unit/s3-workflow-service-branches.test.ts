import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as resyncPost } from '../../functions/api/s3/resync'
import { onRequestPost as backfillRetryPost } from '../../functions/api/s3/backfill-retry'
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from '../../functions/api/s3/settings'
import { onRequestGet as entryStatusGet } from '../../functions/api/s3/entry-status/[date]'
import { onRequestPost as entryResyncPost } from '../../functions/api/s3/entry-resync/[date]'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../functions/_shared/drive')>(),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  writeJsonFile: vi.fn().mockImplementation(async (_token, _folderId, name) => ({
    id: name === 's3_settings.json' ? 'settings-file' : 'status-file', name,
  })),
}))

vi.mock('../../functions/_shared/session', async importOriginal => ({
  ...await importOriginal<typeof import('../../functions/_shared/session')>(),
  saveSession: vi.fn().mockResolvedValue(undefined),
  getValidIdToken: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../functions/_shared/s3Settings', async importOriginal => ({
  ...await importOriginal<typeof import('../../functions/_shared/s3Settings')>(),
  getS3Settings: vi.fn(),
  loadS3SettingsRecord: vi.fn(),
  backfillAllEntries: vi.fn().mockResolvedValue(undefined),
  isBackfillRunActive: vi.fn().mockReturnValue(false),
  resyncSingleEntry: vi.fn().mockResolvedValue(undefined),
}))

const config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }
const settingsRecord = {
  config,
  status: {},
  folderId: 'folder-1',
  configFileId: 'settings-file',
  statusFileId: 'status-file',
}

function makeService() {
  return {
    getJob: vi.fn().mockResolvedValue(null),
    startBackfill: vi.fn(),
    mirrorEntry: vi.fn(),
    mirrorEntryNow: vi.fn(),
    deleteEntry: vi.fn(),
    saveSettings: vi.fn(),
    getEntryStatus: vi.fn(),
  }
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const service = makeService()
  const pending: Promise<unknown>[] = []
  const context = {
    request: new Request('https://example.com/api/s3/settings'),
    params: { date: '2026-05-01' },
    data: { accessToken: 'request-access-token', idToken: 'request-id-token', sessionId: 'sid', session: { google_sub: 'google-sub' } },
    env: { S3_WORKFLOW_SERVICE: service },
    waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(promise) }),
    ...overrides,
  }
  return { context: context as any, service, pending }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(s3Settings.getS3Settings).mockResolvedValue(null)
  vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue(settingsRecord as any)
  vi.mocked(s3Settings.backfillAllEntries).mockResolvedValue(undefined)
  vi.mocked(s3Settings.isBackfillRunActive).mockReturnValue(false)
  vi.mocked(s3Settings.resyncSingleEntry).mockResolvedValue({ ok: true })
})

describe('S3 Pages routes do not start durable Workflow jobs', () => {
  it('uses browser-scoped backfill for resync instead of the Workflow RPC', async () => {
    const { context, service, pending } = makeContext({ request: new Request('https://example.com/api/s3/resync', { method: 'POST' }) })
    const response = await resyncPost(context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(service.startBackfill).not.toHaveBeenCalled()
    expect(context.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'request-access-token', 'sid', context.data.session, context.env, settingsRecord, undefined, 'Resync', 20,
    )
    await Promise.all(pending)
  })

  it('uses browser-scoped backfill retry and does not persist OAuth credentials in job params', async () => {
    const failedRecord = { ...settingsRecord, status: { backfillProgress: { failed: ['2026-05-01'] } } }
    vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue(failedRecord as any)
    const { context, service, pending } = makeContext({ request: new Request('https://example.com/api/s3/backfill-retry', { method: 'POST' }) })
    const response = await backfillRetryPost(context)

    expect(response.status).toBe(200)
    expect(service.startBackfill).not.toHaveBeenCalled()
    expect(context.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'request-access-token', 'sid', context.data.session, context.env, failedRecord, ['2026-05-01'], 'Retry', 20,
    )
    await Promise.all(pending)
  })

  it('reads settings directly and does not derive status from a durable job payload', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(config)
    const { context, service } = makeContext()
    const response = await settingsGet(context)

    expect(await response.json()).toEqual(config)
    expect(service.getJob).not.toHaveBeenCalled()
    expect(service.startBackfill).not.toHaveBeenCalled()
  })

  it('saves settings on Drive and drives initial backfill in the open browser session', async () => {
    vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue({ ...settingsRecord, config: { ...config, enabled: false } } as any)
    const { context, service, pending } = makeContext({
      request: new Request('https://example.com/api/s3/settings', { method: 'PUT', body: JSON.stringify(config) }),
    })
    const response = await settingsPut(context)

    expect(response.status).toBe(200)
    expect(drive.writeJsonFile).toHaveBeenCalled()
    expect(service.saveSettings).not.toHaveBeenCalled()
    expect(service.startBackfill).not.toHaveBeenCalled()
    expect(context.waitUntil).toHaveBeenCalledOnce()
    await Promise.all(pending)
  })

  it('does not use legacy Worker mirroring for entry status or manual retry', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue({ ...config, enabled: false })
    const { context, service } = makeContext({
      request: new Request('https://example.com/api/s3/entry-status/2026-05-01?version=5'),
      params: { date: '2026-05-01' },
    })
    const statusResponse = await entryStatusGet(context)
    expect(await statusResponse.json()).toEqual({ status: 'disabled' })

    vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue(settingsRecord as any)
    const retryResponse = await entryResyncPost(makeContext({
      request: new Request('https://example.com/api/s3/entry-resync/2026-05-01', { method: 'POST' }),
      params: { date: '2026-05-01' },
    }).context)
    expect(retryResponse.status).toBe(200)
    expect(s3Settings.resyncSingleEntry).toHaveBeenCalled()
    for (const method of [service.startBackfill, service.mirrorEntry, service.mirrorEntryNow, service.deleteEntry]) {
      expect(method).not.toHaveBeenCalled()
    }
  })
})
