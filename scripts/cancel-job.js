#!/usr/bin/env node
'use strict';

/**
 * scripts/cancel-job.js — gracefully stops a knowledge-engine job
 * (crawl+ingest): in-flight work finishes, no new work is claimed,
 * whatever was already indexed stays indexed. Safe to call even if the
 * job seems stuck — works cross-process via a durable flag
 * (jobs.cancel_requested) picked up by the owning process's own
 * heartbeat tick (src/knowledge-engine/jobs/job-manager.js).
 *
 * Deliberately talks to storage/jobs-db.js directly instead of going
 * through src/knowledge-engine/index.js: requiring that module and
 * calling any of its functions lazily constructs the full JobManager
 * singleton, which immediately self-pumps and can start claiming and
 * *running* any other queued job in this disposable script's own
 * process — exactly the kind of side effect a one-off CLI command must
 * not have.
 *
 * Usage: npm run cancel-job -- <jobId>
 */

require('dotenv').config();
const { getJobsDb } = require('../src/knowledge-engine/storage/jobs-db');

const jobId = process.argv[2];
if (!jobId) {
  console.error('Uso: npm run cancel-job -- <jobId>');
  process.exit(1);
}

const jobsDb = getJobsDb();
const job = jobsDb.getJob(jobId);
if (!job) {
  console.error(`Job non trovato: ${jobId}`);
  process.exit(1);
}

if (job.status === 'queued' || job.status === 'paused') {
  jobsDb.setStatus(jobId, 'cancelled');
  console.log(`Job ${jobId} era '${job.status}' (mai partito) — impostato direttamente a 'cancelled'.`);
} else if (job.status === 'running') {
  jobsDb.requestCancel(jobId);
  console.log(`Richiesta di stop inviata per ${jobId} (owner: ${job.owner || '—'}).`);
  console.log(`Il processo che lo sta eseguendo la raccoglie al prossimo heartbeat (di norma entro pochi secondi) e si ferma da solo, mantenendo quanto già indicizzato.`);
} else {
  console.log(`Job ${jobId} è già '${job.status}' — nessuna azione necessaria.`);
}
