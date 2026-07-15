'use strict';

/**
 * Knowledge Ingestion Engine — public API.
 *
 * A ground-up, self-contained crawl + ingestion subsystem: persistent
 * URL frontier, resumable streaming ingestion (HTML -> clean text ->
 * chunks -> embeddings -> LanceDB), all state surviving process
 * restarts. It shares no code with the crawler/pipeline/queue this
 * replaces — the only thing it reuses from the rest of the project is
 * the already-provided embedding client and LanceDB helper
 * (src/lib/embeddings.js, src/lib/lancedb.js), so ingested content
 * lands exactly where the existing RAG/chat path already looks for it.
 *
 * Everything except the four functions below is internal.
 */

const OpenAI = require('openai');
const { getJobManager } = require('./jobs/job-manager');

let _openai = null;
function optionalOpenaiClient() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function requireOpenai() {
  const client = optionalOpenaiClient();
  if (!client) throw new Error('knowledge-engine: OPENAI_API_KEY is not set');
  return client;
}

function manager() {
  return getJobManager({ openai: optionalOpenaiClient() });
}

/**
 * Enqueues an ingestion job. Runs entirely in the background — returns
 * as soon as the job is durably recorded.
 *
 *   job.id        optional; also the idempotency key and vector-store
 *                 namespace. Reusing an id resumes/replays that job
 *                 instead of duplicating pages or vectors. Omit to get
 *                 a fresh generated id.
 *   job.seedUrls  required, non-empty array of URLs to crawl.
 *   job.options   optional overrides (see config.js): maxDepth,
 *                 maxPages, crawlConcurrency, hostConcurrency, etc.
 *
 * Returns { jobId }.
 */
function enqueueJob(job) {
  requireOpenai();
  return manager().enqueueJob(job);
}

/**
 * Full observability snapshot for a job: status, queued/discovered/
 * fetched/failed URLs, embedded/indexed chunks, throughput, ETA, and
 * recent log lines. Returns null for an unknown job id.
 */
function getJobStatus(jobId) {
  return manager().getJobStatus(jobId);
}

/** Graceful stop: in-flight work finishes, no new work is claimed. */
function cancelJob(jobId) {
  return manager().cancelJob(jobId);
}

/** Explicitly resumes a cancelled/failed/completed job from persisted state. */
function resumeJob(jobId) {
  requireOpenai();
  return manager().resumeJob(jobId);
}

module.exports = { enqueueJob, getJobStatus, cancelJob, resumeJob };
