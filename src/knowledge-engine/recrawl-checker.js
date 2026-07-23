'use strict';

/**
 * recrawl-checker.js — periodic "has this demo's site changed?" checker
 * and targeted (not full-site) recrawl trigger.
 *
 * Reuses src/lib/site-analyzer.js's analyzeSite() — the same per-page
 * freshness detection ("Analizza sito") already used interactively when
 * creating a demo — to decide WHICH pages changed, without touching the
 * knowledge-engine at all. Only pages whose site-reported lastModified
 * date is newer than the demo's last check get requeued for an actual
 * crawl+re-embed, via the knowledge-engine's existing JobManager
 * (shared MAX_CONCURRENT_JOBS=2 cap, no new concurrency code needed
 * here).
 *
 * History of every check/recrawl run is persisted to
 * data/knowledge-engine/recrawl-history.json, keyed by demo id, for the
 * admin history page (public/admin_recrawl_history.html) and for this
 * module's own "when did we last check this demo" gate.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { analyzeSite } = require('../lib/site-analyzer');
const { loadDemos } = require('../lib/demos-store');
const { CrawlDb, dbPathForJob } = require('./storage/crawl-db');
const { deleteChunksForUrl } = require('./vectorstore/lancedb-store');
const { resumeJob, getJobStatus } = require('./index');
const { sleep } = require('./lib/retry');

const DEFAULT_INTERVAL_DAYS = 7;
const BATCH_CHECK_CONCURRENCY = 3; // parallel analyzeSite calls — cheap, independent of the knowledge-engine's own job concurrency
const JOB_POLL_INTERVAL_MS = 5000;
const JOB_POLL_TIMEOUT_MS = 30 * 60 * 1000; // give up waiting after 30min; the job itself keeps running regardless
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'knowledge-engine', 'recrawl-history.json');
const LOCK_DIR = `${HISTORY_FILE}.lock`;

// ─── History store (data/knowledge-engine/recrawl-history.json) ────────────

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return {}; }
}

/** fs.mkdirSync is atomic — doubles as a cross-process mutex around the write step. */
function withHistoryLock(fn) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch {
    throw new Error('recrawl-history.json è in uso da un altro controllo/recrawl in corso — riprova tra poco');
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(LOCK_DIR); } catch {}
  }
}

function recordRun(demo, record) {
  withHistoryLock(() => {
    const history = readHistory();
    const entry = history[demo.id] || { runs: [] };
    entry.knowledgeBaseId = demo.knowledgeBaseId;
    entry.clientUrl = demo.clientUrl;
    entry.lastRunAt = record.finishedAt;
    entry.lastRunOutcome = record.outcome;
    entry.runs = entry.runs || [];
    entry.runs.push(record);
    history[demo.id] = entry;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  });
}

function newRunId() {
  return crypto.randomUUID();
}

// ─── Gate: is this demo due for an automatic (cron) check? ─────────────────

function sinceDateFor(demo, history) {
  const lastRunAt = history[demo.id]?.lastRunAt;
  return lastRunAt ? new Date(lastRunAt) : new Date(demo.createdAt);
}

function isDueForCronCheck(demo, history) {
  const lastRunAt = history[demo.id]?.lastRunAt;
  if (!lastRunAt) return true;
  const intervalDays = demo.recrawlIntervalDays || DEFAULT_INTERVAL_DAYS;
  const dueAt = new Date(lastRunAt).getTime() + intervalDays * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// ─── Step 1: cheap check — which pages does the site say changed? ─────────

/**
 * Calls analyzeSite (same logic as "Analizza sito") and compares each
 * page's site-reported lastModified against the last time this demo was
 * checked (or its creation date, if never checked). Pages with no
 * detectable lastModified are treated as "presumably unchanged" — never
 * force a recrawl on unknown freshness, to avoid wasting crawl/embedding
 * budget on content with no freshness signal at all.
 */
async function checkDemoForUpdates(demo, history) {
  const sinceDate = sinceDateFor(demo, history);
  const result = await analyzeSite(demo.clientUrl);
  const pages = result.pages || [];

  // 0 pages essentially always means the site was unreachable/blocked for
  // this check (rate-limiting, robots.txt, transient network issue), not
  // "genuinely nothing there" — analyzeSite's own crawl always includes
  // the root seed page first if it could fetch anything at all. Surfacing
  // this as a normal 'no-changes' run would silently mask a failed check
  // as a successful one, so it's treated as an error instead.
  if (!pages.length) {
    throw new Error('Nessuna pagina raggiungibile durante il controllo (sito irraggiungibile o bloccato) — verificare manualmente');
  }

  const pagesChanged = pages
    .filter((p) => {
      if (!p.lastModified) return false;
      const d = new Date(p.lastModified);
      return !isNaN(d.getTime()) && d.getTime() > sinceDate.getTime();
    })
    .map((p) => ({ url: p.url, lastModified: p.lastModified, lastModifiedSource: p.lastModifiedSource }));

  return { sinceDate: sinceDate.toISOString(), pagesChecked: pages.length, pagesChanged };
}

// ─── Step 2: targeted recrawl — purge stale vectors, requeue, resume ───────

/** Fires the targeted recrawl (does not wait for it to finish) — purges each changed URL's old vectors first, then requeues just those URLs and resumes the job. */
async function applyRecrawl(demo, changedUrls) {
  for (const url of changedUrls) {
    try {
      await deleteChunksForUrl(demo.knowledgeBaseId, url);
    } catch (err) {
      console.error(`[recrawl] deleteChunksForUrl failed for ${url}:`, err.message);
    }
  }
  const store = new CrawlDb(dbPathForJob(demo.knowledgeBaseId));
  try {
    store.requeueUrls(changedUrls);
  } finally {
    store.close();
  }
  return resumeJob(demo.knowledgeBaseId);
}

async function waitForJobSettled(jobId) {
  const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
  for (;;) {
    const job = getJobStatus(jobId);
    if (!job || TERMINAL_JOB_STATUSES.has(job.status) || Date.now() >= deadline) {
      return job ? job.status : null; // if we hit the deadline first, the job keeps running in the background regardless — we just stop waiting on it
    }
    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

// ─── Single-demo pipeline (manual command, UI "run now") ───────────────────

/** Full check+recrawl pipeline for one demo, waiting for any triggered recrawl to settle before recording the run. */
async function runRecrawlForDemo(demo, { trigger, triggeredBy = null } = {}) {
  const startedAt = new Date();
  let record;
  try {
    const history = readHistory();
    const { sinceDate, pagesChecked, pagesChanged } = await checkDemoForUpdates(demo, history);

    let pagesRecrawled = [];
    let jobStatusAfter = null;
    let outcome = 'no-changes';

    if (pagesChanged.length) {
      const urls = pagesChanged.map((p) => p.url);
      await applyRecrawl(demo, urls);
      jobStatusAfter = await waitForJobSettled(demo.knowledgeBaseId);
      pagesRecrawled = urls;
      outcome = 'updated';
    }

    record = {
      runId: newRunId(), demoId: demo.id,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      trigger, triggeredBy, sinceDate, pagesChecked, pagesChanged, pagesRecrawled,
      outcome, error: null,
      durationMs: Date.now() - startedAt.getTime(),
      jobStatusAfter
    };
  } catch (err) {
    record = {
      runId: newRunId(), demoId: demo.id,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      trigger, triggeredBy, sinceDate: null, pagesChecked: 0, pagesChanged: [], pagesRecrawled: [],
      outcome: 'error', error: err.message,
      durationMs: Date.now() - startedAt.getTime(),
      jobStatusAfter: null
    };
  }

  recordRun(demo, record);
  return record;
}

// ─── Batch pipeline (nightly cron) ─────────────────────────────────────────

/**
 * Checks every crawling-mode demo due for a check (all of them, for a
 * manual '--all' run; only those past their recrawlIntervalDays, for the
 * nightly cron). Checks run with limited concurrency (cheap analyzeSite
 * calls); recrawls for demos found to have changed pages are then fired
 * and awaited together, so one large recrawl never blocks checking the
 * rest of the batch.
 */
async function runRecrawlBatch({ trigger } = {}) {
  const demos = loadDemos().filter((d) => d.searchMode === 'crawling' && d.knowledgeBaseId);
  const history = readHistory();
  const candidates = trigger === 'cron' ? demos.filter((d) => isDueForCronCheck(d, history)) : demos;

  const checked = [];
  let cursor = 0;
  async function checkWorker() {
    while (cursor < candidates.length) {
      const demo = candidates[cursor++];
      try {
        const { sinceDate, pagesChecked, pagesChanged } = await checkDemoForUpdates(demo, history);
        checked.push({ demo, sinceDate, pagesChecked, pagesChanged, error: null });
      } catch (err) {
        checked.push({ demo, sinceDate: null, pagesChecked: 0, pagesChanged: [], error: err.message });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CHECK_CONCURRENCY, candidates.length) }, checkWorker)
  );

  const results = [];
  const pendingJobs = [];

  for (const c of checked) {
    const startedAt = new Date();
    if (c.error) {
      const record = {
        runId: newRunId(), demoId: c.demo.id, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
        trigger, triggeredBy: null, sinceDate: null, pagesChecked: 0, pagesChanged: [], pagesRecrawled: [],
        outcome: 'error', error: c.error, durationMs: 0, jobStatusAfter: null
      };
      recordRun(c.demo, record);
      results.push(record);
      continue;
    }
    if (!c.pagesChanged.length) {
      const record = {
        runId: newRunId(), demoId: c.demo.id, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
        trigger, triggeredBy: null, sinceDate: c.sinceDate, pagesChecked: c.pagesChecked,
        pagesChanged: [], pagesRecrawled: [], outcome: 'no-changes', error: null,
        durationMs: Date.now() - startedAt.getTime(), jobStatusAfter: null
      };
      recordRun(c.demo, record);
      results.push(record);
      continue;
    }

    const urls = c.pagesChanged.map((p) => p.url);
    try {
      await applyRecrawl(c.demo, urls);
      pendingJobs.push({ demo: c.demo, startedAt, sinceDate: c.sinceDate, pagesChecked: c.pagesChecked, pagesChanged: c.pagesChanged, urls });
    } catch (err) {
      const record = {
        runId: newRunId(), demoId: c.demo.id, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
        trigger, triggeredBy: null, sinceDate: c.sinceDate, pagesChecked: c.pagesChecked,
        pagesChanged: c.pagesChanged, pagesRecrawled: [], outcome: 'error', error: err.message,
        durationMs: Date.now() - startedAt.getTime(), jobStatusAfter: null
      };
      recordRun(c.demo, record);
      results.push(record);
    }
  }

  // All targeted recrawls are already fired (queued/running via the
  // knowledge-engine's own JobManager, which caps real concurrency at
  // MAX_CONCURRENT_JOBS regardless of how many we fired here) — now wait
  // on them together instead of one at a time.
  await Promise.all(
    pendingJobs.map(async (p) => {
      const jobStatusAfter = await waitForJobSettled(p.demo.knowledgeBaseId);
      const record = {
        runId: newRunId(), demoId: p.demo.id, startedAt: p.startedAt.toISOString(), finishedAt: new Date().toISOString(),
        trigger, triggeredBy: null, sinceDate: p.sinceDate, pagesChecked: p.pagesChecked,
        pagesChanged: p.pagesChanged, pagesRecrawled: p.urls, outcome: 'updated', error: null,
        durationMs: Date.now() - p.startedAt.getTime(), jobStatusAfter
      };
      recordRun(p.demo, record);
      results.push(record);
    })
  );

  return results;
}

module.exports = {
  DEFAULT_INTERVAL_DAYS,
  readHistory,
  checkDemoForUpdates,
  runRecrawlForDemo,
  runRecrawlBatch
};
