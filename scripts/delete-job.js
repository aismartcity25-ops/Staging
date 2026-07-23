#!/usr/bin/env node
'use strict';

/**
 * scripts/delete-job.js — permanently removes a knowledge-engine job:
 * unlike cancel-job.js (which just flips status to 'cancelled' and
 * leaves everything else in place), this deletes the row from the
 * global jobs registry, the per-job crawl+ingest state (crawl-db
 * sqlite), and the job's LanceDB vector store. Nothing is left for
 * upsertQueued()/resumeJob() to revive — a later enqueueJob() with the
 * same id starts completely fresh, as if that id had never existed.
 *
 * If the job is currently 'running', a cancel is requested first so
 * the owning process (if any) stops touching its files, but this does
 * NOT wait for that to happen before deleting — see the printed
 * warning in that case.
 *
 * Usage: npm run delete-job -- <jobId>
 */

require('dotenv').config();
const { getJobsDb } = require('../src/knowledge-engine/storage/jobs-db');
const { deleteJobDb } = require('../src/knowledge-engine/storage/crawl-db');
const { deleteKnowledgeBase } = require('../src/lib/lancedb');
const { loadDemos } = require('../src/lib/demos-store');

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Uso: npm run delete-job -- <jobId>');
    process.exit(1);
  }

  const jobsDb = getJobsDb();
  const job = jobsDb.getJob(jobId);
  if (!job) {
    console.error(`Job non trovato: ${jobId} (potrebbe essere già stato eliminato).`);
    process.exit(1);
  }

  const linkedDemo = loadDemos().find((d) => d.knowledgeBaseId === jobId);
  if (linkedDemo) {
    console.warn(`⚠️  Attenzione: la demo "${linkedDemo.clientUrl}" (${linkedDemo.id}) fa ancora riferimento a questo job.`);
    console.warn(`   Dopo l'eliminazione quella demo non avrà più contenuti indicizzati finché non viene ricreata/ri-crawlata.`);
  }

  if (job.status === 'running') {
    jobsDb.requestCancel(jobId);
    console.warn(`⚠️  Il job era 'running' (owner: ${job.owner || '—'}). Richiesto lo stop, ma l'eliminazione procede subito`);
    console.warn(`   senza attendere che il processo lo raccolga — se è vivo, i suoi prossimi tentativi di scrittura falliranno silenziosamente (dati già rimossi).`);
  }

  jobsDb.deleteJob(jobId);
  console.log(`✓ Rimossa la riga del job dal registro globale (jobs.sqlite)`);

  deleteJobDb(jobId);
  console.log(`✓ Rimosso lo stato di crawl/ingest per-job (data/knowledge-engine/jobs/${jobId}.sqlite)`);

  await deleteKnowledgeBase(jobId);
  console.log(`✓ Rimossa la knowledge base / i vettori LanceDB (data/knowledge-engine/lancedb/${jobId})`);

  console.log(`\nJob ${jobId} eliminato definitivamente — non verrà mai più ripreso o riutilizzato.`);
}

main().catch((err) => {
  console.error('delete-job fallito:', err.stack || err.message);
  process.exit(1);
});
