'use strict';

/**
 * jobs/job-manager.js — Job lifecycle: enqueueJob / getJobStatus /
 * cancelJob / resumeJob. This is the only place that decides which
 * queued jobs actually get a JobRunner right now (bounded by
 * maxConcurrentJobs) and the only place that talks to the global jobs
 * registry (storage/jobs-db.js).
 *
 * Multi-process safe by construction, not by convention: claiming a
 * queued job is a single atomic UPDATE (jobsDb.claimQueued), so if this
 * module gets require()'d from more than one OS process at once (a
 * second server instance, a one-off status-check script, a future CLI —
 * all of which construct a JobManager the moment they call any of the
 * four public functions) at most one of them ever actually runs a given
 * job. Reclaiming a 'running' job back to 'queued' only happens once its
 * heartbeat has gone stale (see storage/jobs-db.js) — i.e. its owning
 * process actually died — never just because a fresh process looked at
 * it. cancelJob() sets a flag the owning process's heartbeat tick picks
 * up, so it works correctly even when the caller isn't the owner.
 */

const os = require('os');
const { getJobsDb } = require('../storage/jobs-db');
const { JobRunner } = require('./job-runner');
const { newId } = require('../lib/ids');
const { DEFAULT_OPTIONS, MAX_CONCURRENT_JOBS } = require('../config');

const HEARTBEAT_STALE_MS = 20000; // ~6-7 missed heartbeats (JobRunner beats every 3s) before a 'running' job is considered orphaned
const RECLAIM_INTERVAL_MS = 10000;

class JobManager {
  constructor({ openai, maxConcurrentJobs = MAX_CONCURRENT_JOBS } = {}) {
    this.openai = openai;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.jobsDb = getJobsDb();
    this.ownerId = `${os.hostname()}:${process.pid}:${newId()}`;
    this._active = new Map(); // jobId -> { runner, cancelRequested }

    const reclaimed = this.jobsDb.reclaimStale(HEARTBEAT_STALE_MS);
    if (reclaimed) {
      console.log(`[knowledge-engine] reclaimed ${reclaimed} job(s) with a stale heartbeat — resuming`);
    }
    setImmediate(() => this._pump());

    // Keeps picking up (a) jobs orphaned by a crash after the initial
    // check above, and (b) jobs enqueued/resumed by another process.
    this._reclaimTimer = setInterval(() => {
      const n = this.jobsDb.reclaimStale(HEARTBEAT_STALE_MS);
      if (n) console.log(`[knowledge-engine] reclaimed ${n} job(s) with a stale heartbeat — resuming`);
      this._pump();
    }, RECLAIM_INTERVAL_MS);
    this._reclaimTimer.unref?.();
  }

  setOpenai(openai) {
    this.openai = openai;
    this._pump();
  }

  /**
   * Enqueue (or re-enqueue) a job. `job.id`, if given, is also the
   * job's idempotency key and its vector-store namespace: calling this
   * again with the same id — after a crash, or deliberately — resumes
   * from persisted state instead of duplicating pages or vectors.
   * Returns immediately; the job runs in the background.
   */
  enqueueJob(job) {
    if (!job || typeof job !== 'object') throw new Error('enqueueJob: job object required');
    const seedUrls = Array.isArray(job.seedUrls) ? job.seedUrls.filter(Boolean) : [];
    if (!seedUrls.length) throw new Error('enqueueJob: job.seedUrls (non-empty array) required');

    const id = String(job.id || newId('job'));
    const options = { ...DEFAULT_OPTIONS, ...(job.options || {}) };
    this.jobsDb.upsertQueued({ id, seedUrls, options });
    this._pump();
    return { jobId: id };
  }

  /** Observability: queued/discovered/fetched/failed urls, embedded/indexed chunks, throughput, ETA, recent logs. */
  getJobStatus(jobId) {
    const id = String(jobId);
    const job = this.jobsDb.getJob(id);
    if (!job) return null;

    const active = this._active.get(id);
    return {
      jobId: id,
      status: job.status,
      error: job.error,
      seedUrls: job.seedUrls,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      stats: active ? active.runner.stats() : job.stats
    };
  }

  /**
   * Graceful stop: in-flight fetches/embeds finish, no new work is
   * claimed. Works even if the job is owned by a different process —
   * cancel_requested is a durable flag the owner's heartbeat tick reads.
   * Safe to resumeJob() afterwards.
   */
  cancelJob(jobId) {
    const id = String(jobId);
    const job = this.jobsDb.getJob(id);
    if (!job) throw new Error(`cancelJob: unknown job ${id}`);

    if (job.status === 'queued' || job.status === 'paused') {
      this.jobsDb.setStatus(id, 'cancelled');
      return { jobId: id, status: 'cancelled' };
    }
    if (job.status !== 'running') {
      return { jobId: id, status: job.status };
    }

    this.jobsDb.requestCancel(id);
    const active = this._active.get(id);
    if (active) {
      active.cancelRequested = true;
      active.runner.stop();
    }
    return { jobId: id, status: 'cancelling' };
  }

  /** Explicitly resume a cancelled/failed/completed job. No-op if it's already running. */
  resumeJob(jobId) {
    const id = String(jobId);
    if (this._active.has(id)) return { jobId: id, status: 'running' };

    const job = this.jobsDb.getJob(id);
    if (!job) throw new Error(`resumeJob: unknown job ${id}`);
    this.jobsDb.requeueForResume(id);
    this._pump();
    return { jobId: id, status: 'queued' };
  }

  _pump() {
    if (!this.openai) return; // nothing runnable yet -- enqueueJob still records the job, it just waits
    while (this._active.size < this.maxConcurrentJobs) {
      const candidate = this.jobsDb.listJobs({ status: 'queued' }).find((j) => !this._active.has(j.id));
      if (!candidate) break;
      const won = this.jobsDb.claimQueued(candidate.id, this.ownerId);
      if (!won) continue; // another process claimed it first; loop will pick the next candidate
      this._start(candidate);
    }
  }

  _start(job) {
    const runner = new JobRunner(job, { openai: this.openai, jobsDb: this.jobsDb, ownerId: this.ownerId });
    const entry = { runner, cancelRequested: false };
    this._active.set(job.id, entry);

    runner.run()
      .then(({ stats }) => {
        this.jobsDb.setStats(job.id, stats);
        this.jobsDb.setStatus(job.id, entry.cancelRequested ? 'cancelled' : 'completed');
      })
      .catch((err) => {
        console.error(`[knowledge-engine] job ${job.id} failed:`, err.message);
        this.jobsDb.setStatus(job.id, 'failed', { error: err.message });
      })
      .finally(() => {
        this._active.delete(job.id);
        this._pump();
      });
  }
}

let _instance = null;
function getJobManager({ openai } = {}) {
  if (!_instance) _instance = new JobManager({ openai });
  else if (openai) _instance.setOpenai(openai);
  return _instance;
}

module.exports = { JobManager, getJobManager };
