import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { S3SyncIndex } from '../src/syncIndex'

function stubFor(name: string) {
  return env.S3_SYNC_INDEX.getByName(name)
}

describe('S3SyncIndex entry state', () => {
  it('moves pending -> synced and records the synced version', async () => {
    const stub = stubFor('account-entry-1')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markPending('2026-01-01', '100', '2026-01-01T00:00:00.000Z')
      expect(instance.getEntry('2026-01-01')?.state).toBe('pending')

      instance.markSynced('2026-01-01', '100', '2026-01-01T00:00:01.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('synced')
      expect(entry?.syncedVersion).toBe('100')
      expect(entry?.lastError).toBeUndefined()
    })
  })

  it('moves pending -> failed and records the error message', async () => {
    const stub = stubFor('account-entry-2')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markPending('2026-01-01', '100', '2026-01-01T00:00:00.000Z')
      instance.markFailed('2026-01-01', '100', 'S3 write failed', '2026-01-01T00:00:01.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('failed')
      expect(entry?.lastError).toBe('S3 write failed')
    })
  })

  it('re-syncs synced -> pending -> synced for a newer Drive version', async () => {
    const stub = stubFor('account-entry-3')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markSynced('2026-01-01', '100', '2026-01-01T00:00:00.000Z')
      instance.markPending('2026-01-01', '200', '2026-01-01T00:00:01.000Z')
      expect(instance.getEntry('2026-01-01')?.state).toBe('pending')
      instance.markSynced('2026-01-01', '200', '2026-01-01T00:00:02.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('synced')
      expect(entry?.syncedVersion).toBe('200')
    })
  })

  it('does not let an older Drive version overwrite an already-synced newer one', async () => {
    const stub = stubFor('account-entry-4')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markSynced('2026-01-01', '200', '2026-01-01T00:00:00.000Z')
      // A stale/out-of-order write (e.g. a slow retry racing a newer save) must not regress the record.
      instance.markSynced('2026-01-01', '100', '2026-01-01T00:00:01.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('synced')
      expect(entry?.syncedVersion).toBe('200')
    })
  })

  it('does not let a stale pending mark regress an already-synced newer version', async () => {
    const stub = stubFor('account-entry-5')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markSynced('2026-01-01', '200', '2026-01-01T00:00:00.000Z')
      instance.markPending('2026-01-01', '100', '2026-01-01T00:00:01.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('synced')
      expect(entry?.driveVersion).toBe('200')
    })
  })

  it('does not let a stale failure regress an already-synced newer version', async () => {
    const stub = stubFor('account-entry-6')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markSynced('2026-01-01', '200', '2026-01-01T00:00:00.000Z')
      instance.markFailed('2026-01-01', '100', 'stale failure', '2026-01-01T00:00:01.000Z')
      const entry = instance.getEntry('2026-01-01')
      expect(entry?.state).toBe('synced')
    })
  })

  it('markDeleted removes the entry entirely', async () => {
    const stub = stubFor('account-entry-7')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.markSynced('2026-01-01', '100', '2026-01-01T00:00:00.000Z')
      instance.markDeleted('2026-01-01')
      expect(instance.getEntry('2026-01-01')).toBeNull()
    })
  })
})

describe('S3SyncIndex backfill jobs', () => {
  it('creates a job and reports it as queued', async () => {
    const stub = stubFor('account-job-1')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      const reservation = instance.startJob('req-1', 'job-1', 'wf-1', true, '2026-01-01T00:00:00.000Z')
      expect(reservation.created).toBe(true)
      expect(reservation.job.state).toBe('queued')
      expect(reservation.job.jobId).toBe('job-1')
    })
  })

  it('dedups a retried start with the same requestId instead of creating a second job', async () => {
    const stub = stubFor('account-job-2')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      const first = instance.startJob('req-2', 'job-2', 'wf-2', true, '2026-01-01T00:00:00.000Z')
      const retry = instance.startJob('req-2', 'job-3', 'wf-3', true, '2026-01-01T00:00:01.000Z')
      expect(retry.created).toBe(false)
      expect(retry.job.jobId).toBe('job-2')
    })
  })

  it('refuses a second concurrent backfill for the same account', async () => {
    const stub = stubFor('account-job-3')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-a', 'job-a', 'wf-a', true, '2026-01-01T00:00:00.000Z')
      expect(() => instance.startJob('req-b', 'job-b', 'wf-b', true, '2026-01-01T00:00:01.000Z')).toThrow('already running')
    })
  })

  it('allows a new backfill once the previous one has finished', async () => {
    const stub = stubFor('account-job-4')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-a', 'job-a', 'wf-a', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-a')
      instance.finishJob('job-a', '2026-01-01T00:00:01.000Z')
      const next = instance.startJob('req-b', 'job-b', 'wf-b', true, '2026-01-01T00:00:02.000Z')
      expect(next.created).toBe(true)
    })
  })

  it('refuses to start a job when backup is not enabled', async () => {
    const stub = stubFor('account-job-5')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      expect(() => instance.startJob('req-c', 'job-c', 'wf-c', false, '2026-01-01T00:00:00.000Z')).toThrow('not enabled')
    })
  })

  it('finishJob marks complete when nothing failed, failed when something did', async () => {
    const okStub = stubFor('account-job-6')
    await runInDurableObject(okStub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-ok', 'job-ok', 'wf-ok', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-ok')
      instance.setTotal('job-ok', 2)
      instance.recordProgress('job-ok', 'batch-0', 2, [])
      instance.finishJob('job-ok', '2026-01-01T00:00:01.000Z')
      expect(instance.getJob('job-ok')?.state).toBe('complete')
    })

    const failStub = stubFor('account-job-7')
    await runInDurableObject(failStub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-fail', 'job-fail', 'wf-fail', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-fail')
      instance.setTotal('job-fail', 2)
      instance.recordProgress('job-fail', 'batch-0', 1, ['2026-01-05'])
      instance.finishJob('job-fail', '2026-01-01T00:00:01.000Z')
      const job = instance.getJob('job-fail')
      expect(job?.state).toBe('failed')
      expect(job?.failedDates).toEqual(['2026-01-05'])
    })
  })

  it('recordProgress is idempotent for a replayed batchKey', async () => {
    const stub = stubFor('account-job-8')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-idem', 'job-idem', 'wf-idem', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-idem')
      instance.setTotal('job-idem', 10)
      instance.recordProgress('job-idem', 'batch-0', 5, [])
      // A Workflow step retry replaying the same batchKey must not double-count.
      instance.recordProgress('job-idem', 'batch-0', 5, [])
      expect(instance.getJob('job-idem')?.completed).toBe(5)
    })
  })

  it('failJob only affects queued/running jobs, not already-finished ones', async () => {
    const stub = stubFor('account-job-9')
    await runInDurableObject(stub, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.startJob('req-x', 'job-x', 'wf-x', true, '2026-01-01T00:00:00.000Z')
      instance.markRunning('job-x')
      instance.finishJob('job-x', '2026-01-01T00:00:01.000Z')
      instance.failJob('job-x', 'too late', '2026-01-01T00:00:02.000Z')
      expect(instance.getJob('job-x')?.state).toBe('complete')
    })
  })
})

describe('S3SyncIndex account isolation', () => {
  it('keeps entries and jobs from different accounts fully separate', async () => {
    const accountA = stubFor('account-iso-a')
    const accountB = stubFor('account-iso-b')

    await runInDurableObject(accountA, async (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.markSynced('2026-01-01', '100', '2026-01-01T00:00:00.000Z')
      instance.startJob('req-a', 'job-a', 'wf-a', true, '2026-01-01T00:00:00.000Z')
    })

    await runInDurableObject(accountB, async (instance: S3SyncIndex) => {
      expect(instance.getEntry('2026-01-01')).toBeNull()
      expect(instance.getBackupEnabled()).toBeNull()
      expect(instance.getJob()).toBeNull()
      // Account B must be able to start its own job even though A has one running.
      const reservation = instance.startJob('req-b', 'job-b', 'wf-b', true, '2026-01-01T00:00:00.000Z')
      expect(reservation.created).toBe(true)
    })
  })
})

describe('S3SyncIndex workflow usage counter', () => {
  // Every test in this block shares the same well-known instance name (see
  // USAGE_TRACKER_KEY in runtime.ts), so each uses its own date to avoid
  // interfering with the others.
  it('starts at zero for a date with no recorded steps', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      expect(instance.getWorkflowStepUsage('2026-02-01')).toBe(0)
    })
  })

  it('increments once per call and returns the running total', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(1)
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(2)
      expect(instance.recordWorkflowStep('2026-02-02')).toBe(3)
      expect(instance.getWorkflowStepUsage('2026-02-02')).toBe(3)
    })
  })

  it('tracks each date independently', async () => {
    await runInDurableObject(stubFor('__workflow_usage__'), async (instance: S3SyncIndex) => {
      instance.recordWorkflowStep('2026-03-01')
      instance.recordWorkflowStep('2026-03-01')
      instance.recordWorkflowStep('2026-03-02')
      expect(instance.getWorkflowStepUsage('2026-03-01')).toBe(2)
      expect(instance.getWorkflowStepUsage('2026-03-02')).toBe(1)
    })
  })
})
