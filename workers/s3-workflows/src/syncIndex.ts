import { DurableObject } from 'cloudflare:workers'
import { isAtLeast } from '../../../functions/_shared/s3'
import type { BackfillJob, EntrySyncStatus, S3SyncState } from '../../../functions/_shared/s3Workflow'
import type { WorkflowEnv } from './types'
import { authorizedSession, mirrorEntryCore, safeError, type MirrorEntryCoreInput, type S3Config } from './runtime'
import { ensureFolder, findJsonFile, readJsonFile, writeJsonFile } from '../../../functions/_shared/drive'
import { getValidAccessToken } from '../../../functions/_shared/session'
import { isValidS3Settings } from '../../../functions/_shared/s3Settings'
import type { S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'

interface JobReservation {
  job: BackfillJob
  created: boolean
}

interface JobRow {
  [key: string]: string | number | null
  job_id: string
  state: string
  total: number
  completed: number
  failed: number
  failed_dates: string
  started_at: string
  finished_at: string | null
  workflow_id: string
  error: string | null
}

interface EntryRow {
  [key: string]: string | number | null
  date: string
  drive_version: string | null
  file_id: string | null
  synced_version: string | null
  state: string
  updated_at: string
  last_error: string | null
}

function parseFailedDates(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(date => typeof date === 'string') ? parsed : []
  } catch {
    return []
  }
}

// Must exceed the worst-case time a single *live* Workflow step can spend before
// its next DO write (markRunning/recordProgress/finishJob/failJob all bump
// updated_at) — otherwise a step that's still legitimately retrying gets its job
// declared orphaned and failed out from under it while the Workflow instance is
// still going to resume writing. Worst case, per workflow.ts: STEP_TIMEOUT (2 min)
// x (BOOKKEEPING_STEP_RETRIES.limit + 1) attempts plus exponential backoff between
// them — bookkeeping steps are DO-only and effectively instant in practice, but
// this is sized against the theoretical bound, not the common case. 10 minutes
// leaves comfortable margin above that.
const JOB_ORPHAN_TIMEOUT_MS = 10 * 60 * 1000

function isOrphaned(row: JobRow): boolean {
  const lastActiveStr = (row.updated_at as string | null) ?? (row.started_at as string)
  const lastActive = new Date(lastActiveStr).getTime()
  return Number.isFinite(lastActive) && Date.now() - lastActive > JOB_ORPHAN_TIMEOUT_MS
}

export class S3SyncIndex extends DurableObject<WorkflowEnv> {
  private tail: Promise<unknown> = Promise.resolve()
  private settingsUpdating = false

  // Serialize remote S3 operations and target changes, without holding a storage
  // transaction across network requests. Failed operations never poison the queue.
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(operation)
    this.tail = run.then(() => {}, () => {})
    return run
  }

  async reconcileEntry(input: MirrorEntryCoreInput): Promise<void> {
    await authorizedSession(this.env, input)
    return this.serialize(() => mirrorEntryCore(this.env, this, input))
  }

  async saveBackupSettings(input: S3WorkflowAuth & { config: S3Config }) {
    if (!isValidS3Settings(input.config)) throw new Error('Invalid S3 settings')
    return this.serialize(async () => {
      const session = await authorizedSession(this.env, input)
      const accessToken = await getValidAccessToken(input.sessionId, session, this.env)
      const folder = await ensureFolder(accessToken, input.sessionId, session, this.env)
      const file = await findJsonFile(accessToken, folder, 's3_settings.json')
      const old = file ? await readJsonFile<S3Config>(accessToken, file) : null
      // Retain the old target before remote I/O so a lost Drive response cannot
      // make a retried bucket change look like a plain re-save.
      const target = this.configValue('bucket') ?? old?.bucket ?? ''
      const bucketChanged = target !== input.config.bucket
      const needsBackfill = input.config.enabled && (bucketChanged || !old?.enabled || this.configValue('backfill_required') === '1')
      if (bucketChanged || needsBackfill) this.assertNoActiveJob()
      this.setConfigValue('bucket', target)
      if (needsBackfill) this.setConfigValue('backfill_required', '1')
      this.settingsUpdating = true
      try {
        const meta = await writeJsonFile(accessToken, folder, 's3_settings.json', input.config, file ?? undefined)
        if (bucketChanged) this.resetAllData()
        this.setConfigValue('bucket', input.config.bucket)
        this.setBackupEnabled(input.config.enabled)
        return { meta, needsBackfill }
      } finally {
        this.settingsUpdating = false
      }
    })
  }

  private configValue(key: string): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM account_config WHERE key = ?', key).toArray()[0]?.value ?? null
  }

  private setConfigValue(key: string, value: string): void {
    this.ctx.storage.sql.exec('INSERT INTO account_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  markBackfillStarted(bucket: string): void {
    if (this.configValue('bucket') === bucket) this.setConfigValue('backfill_required', '0')
  }

  private assertNoActiveJob(): void {
    const active = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1").toArray()[0]
    if (active && !isOrphaned(active)) throw new Error('A backfill is already running')
  }

  async queueDeletion(input: S3WorkflowAuth & { date: string }, requestId: string): Promise<void> {
    await authorizedSession(this.env, input)
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_deletions (date, request_id, session_id, account_key, next_attempt, attempts)
         VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(date) DO UPDATE SET request_id = excluded.request_id,
         session_id = excluded.session_id, account_key = excluded.account_key, next_attempt = excluded.next_attempt, attempts = 0`,
        input.date, requestId, input.sessionId, input.accountKey, Date.now() + 5 * 60_000,
      )
      await this.scheduleDeletionAlarm()
    })
  }

  async completeDeletion(date: string, requestId: string): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec('DELETE FROM pending_deletions WHERE date = ? AND request_id = ?', date, requestId)
      await this.scheduleDeletionAlarm()
    })
  }

  async deferDeletion(date: string, requestId: string, nextAttempt: number): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec('UPDATE pending_deletions SET next_attempt = ? WHERE date = ? AND request_id = ?', nextAttempt, date, requestId)
      await this.scheduleDeletionAlarm()
    })
  }

  private async scheduleDeletionAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ next: number | null }>('SELECT MIN(next_attempt) AS next FROM pending_deletions').one().next
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next))
  }

  async alarm(): Promise<void> {
    // Process one date per invocation to bound external subrequests. A deletion
    // missed its Workflow (or exhausted its retries); reconciliation here uses no
    // Workflow steps and survives object eviction. Never blindly replay DELETE.
    const row = this.ctx.storage.sql.exec<{ date: string; request_id: string; session_id: string; account_key: string; attempts: number }>(
      'SELECT date, request_id, session_id, account_key, attempts FROM pending_deletions WHERE next_attempt <= ? ORDER BY next_attempt LIMIT 1', Date.now(),
    ).toArray()[0]
    try {
      if (row) {
        await this.reconcileEntry({ sessionId: row.session_id, accountKey: row.account_key, date: row.date })
        await this.completeDeletion(row.date, row.request_id)
      }
    } catch (error) {
      console.warn('S3 deletion retry deferred', safeError(error))
      if (row) {
        const delay = Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(row.attempts, 5))
        this.ctx.storage.sql.exec('UPDATE pending_deletions SET attempts = attempts + 1, next_attempt = ? WHERE date = ? AND request_id = ?', Date.now() + delay, row.date, row.request_id)
      }
    } finally {
      await this.scheduleDeletionAlarm()
    }
  }

  constructor(ctx: DurableObjectState, env: WorkflowEnv) {
    super(ctx, env)
    // Schema creation must not interleave with an already-queued method call (the
    // CREATE TABLE/ALTER batch is a one-time startup cost, but a request that races
    // ahead of the ALTER could query a table missing updated_at). blockConcurrencyWhile
    // defers every event until the callback completes — the standard DO startup pattern.
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          date TEXT PRIMARY KEY,
          drive_version TEXT,
          synced_version TEXT,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          failed_dates TEXT NOT NULL DEFAULT '[]',
          started_at TEXT NOT NULL,
          finished_at TEXT,
          workflow_id TEXT NOT NULL,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_started_at_idx ON jobs(started_at);
        CREATE TABLE IF NOT EXISTS processed_batches (
          job_id TEXT NOT NULL,
          batch_key TEXT NOT NULL,
          PRIMARY KEY (job_id, batch_key)
        );
        CREATE TABLE IF NOT EXISTS pending_deletions (
          date TEXT PRIMARY KEY, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
          account_key TEXT NOT NULL, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS account_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
      // `updated_at` was added after the jobs table first shipped. Checking for the
      // column up front (rather than running the ALTER in a try/catch) keeps the
      // migration idempotent without swallowing any real SQLite error — a genuine
      // ALTER failure surfaces instead of leaving a schema the code can't use.
      const entryColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(entries)').toArray()
      if (!entryColumns.some(column => column.name === 'file_id')) this.ctx.storage.sql.exec('ALTER TABLE entries ADD COLUMN file_id TEXT')
      const jobColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(jobs)').toArray()
      if (!jobColumns.some(column => column.name === 'updated_at')) {
        this.ctx.storage.sql.exec('ALTER TABLE jobs ADD COLUMN updated_at TEXT')
      }
    })
  }

  private jobFromRow(row: JobRow): BackfillJob {
    return {
      jobId: row.job_id,
      state: row.state as BackfillJob['state'],
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      failedDates: parseFailedDates(row.failed_dates),
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      workflowId: row.workflow_id,
      ...(row.error ? { error: row.error } : {}),
    }
  }

  private findJob(jobId: string): JobRow | null {
    const rows = this.ctx.storage.sql.exec<JobRow>(
      'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE job_id = ?',
      jobId,
    ).toArray()
    return rows[0] ?? null
  }

  startJob(requestId: string, jobId: string, workflowId: string, enabled: boolean, startedAt: string, expectedBucket?: string): JobReservation {
    if (this.settingsUpdating) throw new Error('A settings update is already running')
    if (expectedBucket && this.configValue('bucket') && this.configValue('bucket') !== expectedBucket) throw new Error('S3 backup target changed')
    const existingRequest = this.ctx.storage.sql.exec<JobRow>(
      'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE request_id = ?',
      requestId,
    ).toArray()[0]
    if (existingRequest) return { job: this.jobFromRow(existingRequest), created: false }
    if (!enabled) throw new Error('S3 backup is not enabled')

    const active = this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    ).toArray()[0]
    if (active) {
      if (isOrphaned(active)) {
        this.failJob(active.job_id, 'Job abandoned or superseded', new Date().toISOString())
      } else {
        throw new Error('A backfill is already running')
      }
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (job_id, request_id, state, started_at, updated_at, workflow_id) VALUES (?, ?, 'queued', ?, ?, ?)",
      jobId,
      requestId,
      startedAt,
      null,
      workflowId,
    )
    const row = this.findJob(jobId)
    if (!row) throw new Error('Failed to create backfill job')
    return { job: this.jobFromRow(row), created: true }
  }

  markStartFailed(jobId: string, message: string, finishedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'queued'",
      finishedAt,
      message.slice(0, 200),
      jobId,
    )
  }

  markRunning(jobId: string): void {
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec("UPDATE jobs SET state = 'running', updated_at = ? WHERE job_id = ? AND state = 'queued'", now, jobId)
  }

  setTotal(jobId: string, total: number): void {
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE jobs SET total = MAX(total, ?), updated_at = ? WHERE job_id = ?', total, now, jobId)
  }

  recordProgress(jobId: string, batchKey: string, completed: number, failedDates: string[]): void {
    const inserted = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO processed_batches (job_id, batch_key) VALUES (?, ?)',
      jobId,
      batchKey,
    )
    if (inserted.rowsWritten === 0) return

    const row = this.findJob(jobId)
    if (!row) throw new Error('Backfill job not found')
    const failed = new Set(row.failed_dates ? parseFailedDates(row.failed_dates) : [])
    for (const date of failedDates) failed.add(date)
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET completed = completed + ?, failed = ?, failed_dates = ?, updated_at = ? WHERE job_id = ?',
      completed,
      failed.size,
      JSON.stringify([...failed].sort()),
      now,
      jobId,
    )
  }

  finishJob(jobId: string, finishedAt: string): void {
    const row = this.findJob(jobId)
    if (!row || row.state === 'cancelled') return
    const state = row.failed > 0 ? 'failed' : 'complete'
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET state = ?, finished_at = ?, completed = MAX(completed, total) WHERE job_id = ?',
      state,
      finishedAt,
      jobId,
    )
  }

  failJob(jobId: string, message: string, finishedAt: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state IN ('queued', 'running')",
      finishedAt,
      message.slice(0, 200),
      jobId,
    )
  }

  getJob(jobId?: string): BackfillJob | null {
    let row = jobId
      ? this.findJob(jobId)
      : this.ctx.storage.sql.exec<JobRow>(
        'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs ORDER BY started_at DESC LIMIT 1',
      ).toArray()[0] ?? null
    if (row && (row.state === 'running' || row.state === 'queued') && isOrphaned(row)) {
      this.failJob(row.job_id, 'Job abandoned or superseded', new Date().toISOString())
      row = jobId ? this.findJob(jobId) : this.ctx.storage.sql.exec<JobRow>(
        'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs ORDER BY started_at DESC LIMIT 1',
      ).toArray()[0] ?? null
    }
    return row ? this.jobFromRow(row) : null
  }

  // Guards against a concurrent in-flight job: without this, a caller that resets
  // right before starting a fresh backfill (see resync.ts) could delete an active
  // job's row out from under it, and startJob's own "already running" check
  // (which only looks at what's currently in the jobs table) would then see
  // nothing there and let a second Workflow chain start alongside the still-live
  // first one. DO method calls are serialized against each other, so this
  // check-then-delete is atomic — no separate lock needed.
  resetAllData(): void {
    const active = this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    ).toArray()[0]
    if (active && !isOrphaned(active)) throw new Error('A backfill is already running')

    this.ctx.storage.sql.exec('DELETE FROM entries')
    this.ctx.storage.sql.exec('DELETE FROM jobs')
    this.ctx.storage.sql.exec('DELETE FROM processed_batches')
  }

  setBackupEnabled(enabled: boolean, resetEntries = false): void {
    if (resetEntries) {
      this.resetAllData()
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO account_config (key, value) VALUES ('enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      enabled ? '1' : '0',
    )
  }

  getBackupEnabled(): boolean | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM account_config WHERE key = 'enabled'",
    ).toArray()[0]
    if (!row) return null
    return row.value === '1'
  }

  // Called only on the single well-known instance returned by usageTrackerStub()
  // (see runtime.ts) — never on a real per-account instance — so this reuses the
  // generic account_config table as a global daily counter rather than needing a
  // second Durable Object class (and the SQLite migration that would require).
  // A single DO instance handles requests one at a time, so this increment can't
  // race across concurrent Workflow steps the way a KV read-modify-write would.
  recordWorkflowStep(date: string): number {
    this.ctx.storage.sql.exec(
      `INSERT INTO account_config (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(account_config.value AS INTEGER) + 1`,
      `usage:${date}`,
    )
    return this.getWorkflowStepUsage(date)
  }

  getWorkflowStepUsage(date: string): number {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      'SELECT value FROM account_config WHERE key = ?',
      `usage:${date}`,
    ).toArray()[0]
    return row ? Number(row.value) : 0
  }

  getEntry(date: string): EntrySyncStatus | null {
    const row = this.ctx.storage.sql.exec<EntryRow>(
      'SELECT date, file_id, drive_version, synced_version, state, updated_at, last_error FROM entries WHERE date = ?',
      date,
    ).toArray()[0]
    if (!row) return null
    return {
      date: row.date,
      ...(row.file_id ? { fileId: row.file_id } : {}),
      ...(row.drive_version ? { driveVersion: row.drive_version } : {}),
      ...(row.synced_version ? { syncedVersion: row.synced_version } : {}),
      state: row.state as S3SyncState,
      updatedAt: row.updated_at,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }
  }

  markPending(date: string, driveVersion: string | undefined, updatedAt: string, fileId?: string): EntrySyncStatus | null {
    const known = this.getEntry(date)
    if (fileId && known && known.fileId !== fileId) this.markDeleted(date)
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && isAtLeast(current.driveVersion, driveVersion) && current.driveVersion !== driveVersion) {
      return current
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, state = 'pending', updated_at = excluded.updated_at, last_error = NULL
       WHERE entries.drive_version IS NULL OR excluded.drive_version IS NULL OR entries.drive_version = excluded.drive_version OR CAST(excluded.drive_version AS INTEGER) >= CAST(entries.drive_version AS INTEGER)`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      current?.syncedVersion ?? null,
      updatedAt,
    )
    if (fileId) this.ctx.storage.sql.exec('UPDATE entries SET file_id = ? WHERE date = ?', fileId, date)
    return this.getEntry(date)
  }

  markSynced(date: string, driveVersion: string | undefined, updatedAt: string, fileId?: string): EntrySyncStatus | null {
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && current.driveVersion !== driveVersion && isAtLeast(current.driveVersion, driveVersion)) return current
    const syncedVersion = current?.syncedVersion && driveVersion && isAtLeast(current.syncedVersion, driveVersion)
      ? current.syncedVersion
      : driveVersion ?? current?.syncedVersion
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'synced', ?, NULL)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, synced_version = excluded.synced_version, state = 'synced', updated_at = excluded.updated_at, last_error = NULL`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      syncedVersion ?? null,
      updatedAt,
    )
    if (fileId) this.ctx.storage.sql.exec('UPDATE entries SET file_id = ? WHERE date = ?', fileId, date)
    return this.getEntry(date)
  }

  markFailed(date: string, driveVersion: string | undefined, error: string, updatedAt: string): EntrySyncStatus | null {
    const current = this.getEntry(date)
    if (current?.driveVersion && driveVersion && current.driveVersion !== driveVersion && isAtLeast(current.driveVersion, driveVersion)) return current
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (date, drive_version, synced_version, state, updated_at, last_error)
       VALUES (?, ?, ?, 'failed', ?, ?)
       ON CONFLICT(date) DO UPDATE SET drive_version = excluded.drive_version, state = 'failed', updated_at = excluded.updated_at, last_error = excluded.last_error`,
      date,
      driveVersion ?? current?.driveVersion ?? null,
      current?.syncedVersion ?? null,
      updatedAt,
      error.slice(0, 200),
    )
    return this.getEntry(date)
  }

  markDeleted(date: string): void {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE date = ?', date)
  }
}
