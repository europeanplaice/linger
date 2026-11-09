import { DurableObject } from 'cloudflare:workers'
import { isAtLeast } from '../../../functions/_shared/s3'
import type { BackfillJob, EntrySyncStatus, S3SyncState } from '../../../functions/_shared/s3Workflow'
import type { WorkflowEnv } from './types'
import { authorizedSession, ensureAccountDiaryFolder, mirrorEntryCore, type MirrorEntryCoreInput, type S3Config } from './runtime'
import { findJsonFile, readJsonFile, writeJsonFile } from '../../../functions/_shared/drive'
import { getValidAccessToken } from '../../../functions/_shared/session'
import { isValidS3Settings } from '../../../functions/_shared/s3Settings'
import type { S3WorkflowAuth } from '../../../functions/_shared/s3Workflow'
import { openVaultValue, sealVaultValue, vaultLookupKey } from '../../../functions/_shared/vaultCrypto'

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
// Keep enough history for the status UI and ordinary client retries without
// letting one row and its batch idempotency keys accumulate forever.
const COMPLETED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function isOrphaned(row: JobRow): boolean {
  const lastActiveStr = (row.updated_at as string | null) ?? (row.started_at as string)
  const lastActive = new Date(lastActiveStr).getTime()
  return Number.isFinite(lastActive) && Date.now() - lastActive > JOB_ORPHAN_TIMEOUT_MS
}

export class S3SyncIndex extends DurableObject<WorkflowEnv> {
  private tail: Promise<unknown> = Promise.resolve()
  private entryTail: Promise<unknown> = Promise.resolve()
  private entryGeneration = 0
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
      const folder = await ensureAccountDiaryFolder(this.env, input.sessionId, session, input.vaultKey)
      const file = await findJsonFile(accessToken, folder, 's3_settings.json')
      const old = file ? await readJsonFile<S3Config>(accessToken, file) : null
      // Retain the old target before remote I/O so a lost Drive response cannot
      // make a retried bucket change look like a plain re-save.
      const bucketChanged = old?.bucket !== input.config.bucket
      const needsBackfill = input.config.enabled && (bucketChanged || !old?.enabled || this.configValue('backfill_required') === '1')
      if (bucketChanged || needsBackfill) this.assertNoActiveJob()
      if (needsBackfill) this.setConfigValue('backfill_required', '1')
      this.settingsUpdating = true
      try {
        const meta = await writeJsonFile(accessToken, folder, 's3_settings.json', input.config, file ?? undefined)
        if (bucketChanged) this.resetAllData()
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

  markBackfillStarted(): void {
    this.setConfigValue('backfill_required', '0')
  }

  private assertNoActiveJob(): void {
    const active = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE state IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1").toArray()[0]
    if (active && !isOrphaned(active)) throw new Error('A backfill is already running')
  }

  // Old pending deletion alarms cannot safely run without an unlocked key.
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM pending_deletions')
    await this.ctx.storage.deleteAlarm()
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
        CREATE TABLE IF NOT EXISTS protected_entries (
          lookup_key TEXT PRIMARY KEY,
          envelope TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS protected_job_dates (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          envelope TEXT NOT NULL,
          PRIMARY KEY (job_id, chunk)
        );
        CREATE TABLE IF NOT EXISTS protected_job_errors (
          job_id TEXT PRIMARY KEY,
          envelope TEXT NOT NULL
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
      // Older versions stored raw Drive file IDs here. The column remains for
      // schema compatibility, but values are no longer needed as a cache and
      // are cleared on every startup. Historical backups may still contain the
      // old values and are handled in the privacy migration plan.
      this.ctx.storage.sql.exec('UPDATE entries SET file_id = NULL WHERE file_id IS NOT NULL')
      this.ctx.storage.sql.exec("DELETE FROM account_config WHERE key = 'bucket'")
      // Pending alarm retries predate request-scoped vault unlock and cannot be
      // resumed without persisting the key. Future retries happen on an
      // authenticated request that supplies it.
      this.ctx.storage.sql.exec('DELETE FROM pending_deletions')
      await this.ctx.storage.deleteAlarm()
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

  private pruneCompletedJobs(now: number): void {
    const cutoff = new Date(now - COMPLETED_JOB_RETENTION_MS).toISOString()
    // Only terminal rows are candidates; keep the full retry window even during bursts.
    this.ctx.storage.sql.exec(
      `DELETE FROM protected_job_dates WHERE job_id IN (
         SELECT job_id FROM jobs
         WHERE state IN ('complete', 'failed', 'cancelled') AND finished_at < ?
       )`, cutoff,
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM protected_job_errors WHERE job_id IN (
         SELECT job_id FROM jobs
         WHERE state IN ('complete', 'failed', 'cancelled') AND finished_at < ?
       )`, cutoff,
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM processed_batches WHERE job_id IN (
         SELECT job_id FROM jobs
         WHERE state IN ('complete', 'failed', 'cancelled')
           AND finished_at < ?
       )`, cutoff,
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM jobs
       WHERE state IN ('complete', 'failed', 'cancelled')
         AND finished_at < ?`, cutoff,
    )
  }

  startJob(requestId: string, jobId: string, workflowId: string, enabled: boolean, startedAt: string, expectedBucket?: string): JobReservation {
    // Bucket names now remain in Drive and request memory only.
    void expectedBucket
    if (this.settingsUpdating) throw new Error('A settings update is already running')
    // The current bucket is read from Drive during reconciliation; never retain
    // the bucket name as plaintext DO configuration.
    const existingRequest = this.ctx.storage.sql.exec<JobRow>(
      'SELECT job_id, state, total, completed, failed, failed_dates, started_at, updated_at, finished_at, workflow_id, error FROM jobs WHERE request_id = ?',
      requestId,
    ).toArray()[0]
    if (existingRequest) return { job: this.jobFromRow(existingRequest), created: false }
    if (!enabled) throw new Error('S3 backup is not enabled')

    this.pruneCompletedJobs(Date.now())

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
    void message
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'queued'",
      finishedAt,
      'Background backup could not start',
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
    // Durable background jobs have been retired. Refuse any old caller that
    // tries to create another plaintext date list after the privacy cutover.
    if (failedDates.length) throw new Error('Background backup is retired')
    const inserted = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO processed_batches (job_id, batch_key) VALUES (?, ?)',
      jobId,
      batchKey,
    )
    if (inserted.rowsWritten === 0) return

    const row = this.findJob(jobId)
    if (!row) throw new Error('Backfill job not found')
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET completed = completed + ?, updated_at = ? WHERE job_id = ?',
      completed,
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
    void message
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state IN ('queued', 'running')",
      finishedAt,
      'Background backup could not finish',
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

    // Invalidate crypto operations that were suspended while the folder or
    // backup target changed, before clearing either index.
    this.entryGeneration++

    this.ctx.storage.sql.exec('DELETE FROM entries')
    this.ctx.storage.sql.exec('DELETE FROM protected_entries')
    this.ctx.storage.sql.exec('DELETE FROM jobs')
    this.ctx.storage.sql.exec('DELETE FROM protected_job_dates')
    this.ctx.storage.sql.exec('DELETE FROM protected_job_errors')
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

  // Entry state is serialized separately from the remote-I/O queue because
  // reconciliation itself calls these methods while holding that queue.
  private async withEntryLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.entryTail.catch(() => {}).then(fn)
    this.entryTail = run.then(() => {}, () => {})
    return run
  }

  private async migrateEntries(auth: S3WorkflowAuth): Promise<void> {
    if (!auth.vaultKey || !auth.accountKey) throw new Error('Vault key required for sync metadata')
    const generation = this.entryGeneration
    const rows = this.ctx.storage.sql.exec<EntryRow>('SELECT date, drive_version, synced_version, state, updated_at, last_error FROM entries').toArray()
    for (const row of rows) {
      const lookup = await vaultLookupKey(auth.vaultKey, auth.accountKey, 's3-sync-date', row.date)
      const value: EntrySyncStatus = {
        date: row.date, state: row.state as S3SyncState, updatedAt: row.updated_at,
        ...(row.drive_version ? { driveVersion: row.drive_version } : {}),
        ...(row.synced_version ? { syncedVersion: row.synced_version } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
      }
      const envelope = await sealVaultValue(auth.vaultKey, auth.accountKey, `s3-sync-entry:${lookup}`, value)
      const existing = this.ctx.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM protected_entries WHERE lookup_key = ?', lookup).toArray()[0]
      if (existing) await openVaultValue<EntrySyncStatus>(auth.vaultKey, auth.accountKey, `s3-sync-entry:${lookup}`, existing.envelope)
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO protected_entries (lookup_key, envelope) VALUES (?, ?)', lookup, envelope)
        this.ctx.storage.sql.exec('DELETE FROM entries WHERE date = ?', row.date)
      })
    }
  }

  private async migrateJobDates(auth: S3WorkflowAuth): Promise<void> {
    if (!auth.vaultKey || !auth.accountKey) throw new Error('Vault key required for sync metadata')
    const generation = this.entryGeneration
    const rows = this.ctx.storage.sql.exec<{ job_id: string; failed_dates: string }>("SELECT job_id, failed_dates FROM jobs WHERE failed_dates <> '[]'").toArray()
    for (const row of rows) {
      let dates: unknown
      try { dates = JSON.parse(row.failed_dates) } catch { throw new Error('Invalid legacy failed-date list') }
      if (!Array.isArray(dates) || !dates.every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('Invalid legacy failed-date list')
      const prior = this.ctx.storage.sql.exec<{ chunk: number; envelope: string }>('SELECT chunk, envelope FROM protected_job_dates WHERE job_id = ? ORDER BY chunk', row.job_id).toArray()
      const merged = new Set<string>(dates)
      for (const part of prior) {
        const previous = await openVaultValue<unknown>(auth.vaultKey, auth.accountKey, `s3-job-dates:${row.job_id}:${part.chunk}`, part.envelope)
        if (!Array.isArray(previous) || !previous.every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('Invalid protected failed-date list')
        for (const date of previous) merged.add(date)
      }
      const uniqueDates = [...merged].sort()
      const envelopes: string[] = []
      for (let i = 0; i < uniqueDates.length; i += 4000) {
        const chunk = i / 4000
        envelopes.push(await sealVaultValue(auth.vaultKey, auth.accountKey, `s3-job-dates:${row.job_id}:${chunk}`, uniqueDates.slice(i, i + 4000)))
      }
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec("UPDATE jobs SET failed_dates = '[]', failed = ? WHERE job_id = ? AND failed_dates = ?", uniqueDates.length, row.job_id, row.failed_dates)
        if (updated.rowsWritten === 0) return
        this.ctx.storage.sql.exec('DELETE FROM protected_job_dates WHERE job_id = ?', row.job_id)
        for (let i = 0; i < envelopes.length; i++) {
          this.ctx.storage.sql.exec('INSERT INTO protected_job_dates (job_id, chunk, envelope) VALUES (?, ?, ?)', row.job_id, i, envelopes[i])
        }
      })
    }
    const errors = this.ctx.storage.sql.exec<{ job_id: string; error: string }>('SELECT job_id, error FROM jobs WHERE error IS NOT NULL').toArray()
    for (const row of errors) {
      const envelope = await sealVaultValue(auth.vaultKey, auth.accountKey, `s3-job-error:${row.job_id}`, row.error)
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec('UPDATE jobs SET error = NULL WHERE job_id = ? AND error = ?', row.job_id, row.error)
        if (updated.rowsWritten !== 0) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO protected_job_errors (job_id, envelope) VALUES (?, ?)', row.job_id, envelope)
      })
    }
  }

  async migrateLegacyMetadata(auth: S3WorkflowAuth): Promise<void> {
    return this.withEntryLock(async () => {
      await this.migrateEntries(auth)
      await this.migrateJobDates(auth)
    })
  }

  async getProtectedJob(auth: S3WorkflowAuth, jobId?: string): Promise<BackfillJob | null> {
    return this.withEntryLock(async () => {
      if (!auth.vaultKey || !auth.accountKey) throw new Error('Vault key required for sync metadata')
      await this.migrateEntries(auth)
      await this.migrateJobDates(auth)
      const job = this.getJob(jobId)
      if (!job) return null
      const chunks = this.ctx.storage.sql.exec<{ chunk: number; envelope: string }>('SELECT chunk, envelope FROM protected_job_dates WHERE job_id = ? ORDER BY chunk', job.jobId).toArray()
      const dates: string[] = []
      for (const row of chunks) {
        dates.push(...await openVaultValue<string[]>(auth.vaultKey, auth.accountKey, `s3-job-dates:${job.jobId}:${row.chunk}`, row.envelope))
      }
      const errorRow = this.ctx.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM protected_job_errors WHERE job_id = ?', job.jobId).toArray()[0]
      const error = errorRow ? await openVaultValue<string>(auth.vaultKey, auth.accountKey, `s3-job-error:${job.jobId}`, errorRow.envelope) : job.error
      return { ...job, failedDates: dates, ...(error ? { error } : {}) }
    })
  }

  private async protectedEntry<T>(auth: S3WorkflowAuth, date: string, fn: (current: EntrySyncStatus | null) => T | Promise<T>): Promise<T> {
    if (!auth.vaultKey || !auth.accountKey) throw new Error('Vault key required for sync metadata')
    const key = auth.vaultKey
    return this.withEntryLock(async () => {
      const generation = this.entryGeneration
      await this.migrateEntries(auth)
      const lookup = await vaultLookupKey(key, auth.accountKey, 's3-sync-date', date)
      const row = this.ctx.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM protected_entries WHERE lookup_key = ?', lookup).toArray()[0]
      const current = row ? await openVaultValue<EntrySyncStatus>(key, auth.accountKey, `s3-sync-entry:${lookup}`, row.envelope) : null
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      return fn(current)
    })
  }

  async getProtectedEntry(auth: S3WorkflowAuth, date: string): Promise<EntrySyncStatus | null> {
    return this.protectedEntry(auth, date, current => current)
  }

  async updateProtectedEntry(auth: S3WorkflowAuth, date: string, state: 'pending' | 'synced' | 'failed' | 'deleted', version?: string, updatedAt?: string, error?: string): Promise<EntrySyncStatus | null> {
    return this.protectedEntry(auth, date, async current => {
      const generation = this.entryGeneration
      const key = auth.vaultKey!
      const lookup = await vaultLookupKey(key, auth.accountKey, 's3-sync-date', date)
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      if (state === 'deleted') {
        this.ctx.storage.sql.exec('DELETE FROM protected_entries WHERE lookup_key = ?', lookup)
        return null
      }
      if (current?.driveVersion && version && current.driveVersion !== version && isAtLeast(current.driveVersion, version)) return current
      const syncedVersion = state === 'synced' && version && (!current?.syncedVersion || !isAtLeast(current.syncedVersion, version))
        ? version : current?.syncedVersion
      const next: EntrySyncStatus = {
        date, state, updatedAt: updatedAt ?? new Date().toISOString(),
        ...((version ?? current?.driveVersion) ? { driveVersion: version ?? current?.driveVersion } : {}),
        ...(syncedVersion ? { syncedVersion } : {}),
        ...(state === 'failed' && error ? { lastError: error.slice(0, 200) } : {}),
      }
      const envelope = await sealVaultValue(key, auth.accountKey, `s3-sync-entry:${lookup}`, next)
      if (generation !== this.entryGeneration) throw new Error('Sync metadata was reset')
      this.ctx.storage.sql.exec('INSERT INTO protected_entries (lookup_key, envelope) VALUES (?, ?) ON CONFLICT(lookup_key) DO UPDATE SET envelope = excluded.envelope', lookup, envelope)
      return next
    })
  }

}
