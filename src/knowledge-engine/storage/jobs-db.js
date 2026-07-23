'use strict';

/**
 * storage/jobs-db.js — Global job registry (one row per ingestion job).
 *
 * This is the single source of truth for "what jobs exist and what state
 * are they in". It is intentionally tiny: the heavy state (URL frontier,
 * fetched pages, ingest queue) lives per-job in storage/crawl-db.js so
 * concurrent jobs never contend on the same SQLite file.
 *
 * A job's 'running' status is a heartbeat-backed lease, not a bare flag:
 * whoever is running it (owner) touches heartbeat_at every few seconds
 * (see JobRunner). reclaimStale() only takes back jobs whose heartbeat
 * has actually gone quiet — i.e. their owning process really did die —
 * instead of reclaiming every 'running' row on sight. That distinction
 * matters because this module gets require()'d by more than just the
 * long-lived server process (a one-off status-check script, a second
 * server instance, a future CLI) and every one of them constructs a
 * JobManager; without a heartbeat, any of those would look at a job
 * another, still-alive process is actively working on, conclude it was
 * orphaned by a crash, and start running it a second time. claimQueued()
 * closes the other half of that hole: transitioning queued -> running is
 * a single atomic UPDATE ... WHERE status = 'queued', so if two
 * processes race to pick up the same job, exactly one of them wins it.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', '..', 'data', 'knowledge-engine', 'jobs.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  seed_urls TEXT NOT NULL,
  options TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | paused | cancelled | completed | failed
  owner TEXT,
  heartbeat_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  stats TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
`;

function now() { return Date.now(); }

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/** Migration-safe: adds columns that didn't exist in databases created before the heartbeat lease was introduced. */
function migrate(db) {
  const cols = columnNames(db, 'jobs');
  if (!cols.has('owner')) db.exec('ALTER TABLE jobs ADD COLUMN owner TEXT');
  if (!cols.has('heartbeat_at')) db.exec('ALTER TABLE jobs ADD COLUMN heartbeat_at INTEGER');
  if (!cols.has('cancel_requested')) db.exec('ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
}

class JobsDb {
  constructor(dbPath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  /** Idempotent: creates the job if new, or resets an existing terminal job back to 'queued' to resume it. */
  upsertQueued({ id, seedUrls, options }) {
    this.db.prepare(`
      INSERT INTO jobs (id, seed_urls, options, status, created_at, updated_at)
      VALUES (@id, @seed_urls, @options, 'queued', @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        status = CASE WHEN jobs.status IN ('cancelled', 'failed', 'paused', 'completed') THEN 'queued' ELSE jobs.status END,
        error = CASE WHEN jobs.status IN ('cancelled', 'failed', 'paused', 'completed') THEN NULL ELSE jobs.error END,
        owner = CASE WHEN jobs.status IN ('cancelled', 'failed', 'paused', 'completed') THEN NULL ELSE jobs.owner END,
        cancel_requested = CASE WHEN jobs.status IN ('cancelled', 'failed', 'paused', 'completed') THEN 0 ELSE jobs.cancel_requested END,
        updated_at = @now
    `).run({
      id: String(id),
      seed_urls: JSON.stringify(seedUrls || []),
      options: JSON.stringify(options || {}),
      now: now()
    });
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(id));
    return row ? this._deserialize(row) : null;
  }

  listJobs({ status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC').all(status)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
    return rows.map((r) => this._deserialize(r));
  }

  _deserialize(row) {
    return {
      ...row,
      seedUrls: JSON.parse(row.seed_urls || '[]'),
      options: JSON.parse(row.options || '{}'),
      stats: row.stats ? JSON.parse(row.stats) : null
    };
  }

  /**
   * Atomically claims one 'queued' job for `owner`. Returns true iff this
   * call won the claim — if another process claimed it first, the WHERE
   * clause matches zero rows and this returns false. Safe to call
   * concurrently from multiple processes on the same job id.
   */
  claimQueued(id, owner) {
    const info = this.db.prepare(`
      UPDATE jobs SET status = 'running', owner = @owner, heartbeat_at = @now,
             started_at = COALESCE(started_at, @now), updated_at = @now
      WHERE id = @id AND status = 'queued'
    `).run({ id: String(id), owner, now: now() });
    return info.changes > 0;
  }

  /**
   * Proof of life for a running job's lease, and the channel through
   * which a cancelJob() call from ANY process reaches the process that
   * actually owns the job. Returns { ok, cancelRequested }: `ok` is
   * false if this process no longer holds the lease (it should stop);
   * `cancelRequested` is true once someone has asked for a graceful stop.
   */
  heartbeat(id, owner) {
    const info = this.db.prepare(`
      UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running' AND owner = ?
    `).run(now(), String(id), owner);
    if (info.changes === 0) return { ok: false, cancelRequested: false };
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(String(id));
    return { ok: true, cancelRequested: !!(row && row.cancel_requested) };
  }

  /** Flags a job for graceful cancellation. Works regardless of which process (if any) currently owns it. */
  requestCancel(id) {
    this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now(), String(id));
  }

  /** Explicit resume: clears any stale cancel flag/ownership and re-queues so the pump picks it up fresh. */
  requeueForResume(id) {
    this.db.prepare(`
      UPDATE jobs SET status = 'queued', owner = NULL, cancel_requested = 0, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), String(id));
  }

  /** Snapshots a job's final (or in-flight) stats so getJobStatus can read them without touching the per-job crawl DB. */
  setStats(id, stats) {
    this.db.prepare('UPDATE jobs SET stats = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(stats || {}), now(), String(id));
  }

  setStatus(id, status, { error = null } = {}) {
    const patch = { status, error, now: now(), id: String(id) };
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.db.prepare(`
        UPDATE jobs SET status = @status, error = @error, owner = NULL, cancel_requested = 0, updated_at = @now, finished_at = @now
        WHERE id = @id
      `).run(patch);
    } else {
      this.db.prepare('UPDATE jobs SET status = @status, error = @error, updated_at = @now WHERE id = @id')
        .run(patch);
    }
  }

  /**
   * Reclaims 'running' jobs whose heartbeat has gone quiet for longer
   * than `staleMs` — i.e. their owning process actually died — back to
   * 'queued' so the pump picks them up again. A job with a fresh
   * heartbeat is left alone even if this call happens in a different
   * process: it is still being worked on, not orphaned.
   */
  reclaimStale(staleMs) {
    const cutoff = now() - staleMs;
    const info = this.db.prepare(`
      UPDATE jobs SET status = 'queued', owner = NULL, updated_at = ?
      WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)
    `).run(now(), cutoff);
    return info.changes;
  }

  /**
   * Permanently removes a job's row from the registry — unlike
   * setStatus('cancelled'), which leaves the row (and its persisted
   * seed_urls/options/stats) in place so upsertQueued() can revive it the
   * next time enqueueJob() is called with the same id. After deleteJob,
   * that same call just creates a brand-new job: nothing is left to
   * resume. Caller is responsible for also removing the per-job crawl
   * state (storage/crawl-db.js#deleteJobDb) and vector store namespace
   * (lib/lancedb.js) — this only clears the registry row.
   */
  deleteJob(id) {
    return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(String(id)).changes > 0;
  }

  close() {
    this.db.close();
  }
}

let _instance = null;
function getJobsDb() {
  if (!_instance) _instance = new JobsDb();
  return _instance;
}

module.exports = { JobsDb, getJobsDb, DEFAULT_DB_PATH };
