#!/usr/bin/env node
'use strict';

/**
 * scripts/job-status.js — quick CLI snapshot of every knowledge-engine job
 * (crawl+ingest) and its current state. Read-only, standalone (no server
 * required — reads data/knowledge-engine/jobs.sqlite directly).
 *
 * Usage: npm run job-status
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'knowledge-engine', 'jobs.sqlite');

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare('SELECT id, status, owner, heartbeat_at, stats FROM jobs ORDER BY created_at DESC').all();
db.close();

if (!rows.length) {
  console.log('Nessun job trovato.');
  process.exit(0);
}

const now = Date.now();
for (const r of rows) {
  let s = {};
  try { s = JSON.parse(r.stats || '{}'); } catch {}

  const heartbeatAge = r.heartbeat_at ? Math.round((now - r.heartbeat_at) / 1000) : null;
  const heartbeat = heartbeatAge === null ? '—' : `${heartbeatAge}s fa${heartbeatAge > 20 && r.status === 'running' ? ' ⚠️ stale' : ''}`;

  console.log(
    `${r.id} | ${r.status.padEnd(9)} | pagine: ${s.fetchedUrls || 0}/${s.discoveredUrls || 0}` +
    ` | indicizzate: ${s.pagesIngested || 0} | falliti: ${s.failedUrls || 0}` +
    ` | throughput: ${s.throughputPagesPerMin || 0}/min | heartbeat: ${heartbeat}`
  );
}
