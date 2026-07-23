'use strict';

/**
 * storage/crawl-db.js — Per-job persistent state: URL frontier, fetched
 * pages (which doubles as the durable ingest queue), content dedup index,
 * robots.txt cache and running counters.
 *
 * One SQLite file per job (data/knowledge-engine/jobs/<jobId>.sqlite), so
 * concurrent jobs never contend on the same file and a job's entire state
 * can be reasoned about / deleted in isolation.
 *
 * Two independent lease-based queues live here:
 *   - `urls`  — the crawl frontier (queued/leased/fetched/failed/skipped).
 *   - `pages` — every successfully fetched page, persisted BEFORE any
 *     quality evaluation, with its own ingest_status
 *     (pending/leased/done/failed) so the ingestion stage can stream
 *     independently of crawl progress and resume after a crash without
 *     re-fetching anything.
 *
 * better-sqlite3 is synchronous; all operations here are small, indexed,
 * single-row/batch reads/writes, so no await is needed and nothing blocks
 * the event loop in practice.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const JOBS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'knowledge-engine', 'jobs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  host TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | leased | fetched | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  skip_reason TEXT,
  discovered_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_urls_claim ON urls(status, next_attempt_at, priority DESC, depth ASC);
CREATE INDEX IF NOT EXISTS idx_urls_lease ON urls(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  canonical_url TEXT,
  title TEXT,
  description TEXT,
  lang TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  ingest_status TEXT NOT NULL DEFAULT 'pending', -- pending | leased | done | failed
  ingest_attempts INTEGER NOT NULL DEFAULT 0,
  ingest_lease_owner TEXT,
  ingest_lease_expires_at INTEGER NOT NULL DEFAULT 0,
  ingest_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_ingest ON pages(ingest_status, ingest_lease_expires_at, fetched_at);

CREATE TABLE IF NOT EXISTS content_hashes (
  hash TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS robots_cache (
  host TEXT PRIMARY KEY,
  body TEXT,
  fetched_at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

function now() { return Date.now(); }

class CrawlDb {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this._prepare();
  }

  _prepare() {
    this.stmts = {
      insertUrl: this.db.prepare(`
        INSERT INTO urls (url, host, depth, priority, status, max_attempts, next_attempt_at, discovered_from, created_at, updated_at)
        VALUES (@url, @host, @depth, @priority, 'queued', @max_attempts, 0, @discovered_from, @now, @now)
        ON CONFLICT(url) DO NOTHING
      `),
      claimUrlBatch: this.db.prepare(`
        SELECT id, url, host, depth, priority, attempts, max_attempts, discovered_from
        FROM urls
        WHERE status = 'queued' AND next_attempt_at <= ?
        ORDER BY priority DESC, depth ASC, id ASC
        LIMIT ?
      `),
      leaseUrl: this.db.prepare(`
        UPDATE urls SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `),
      markUrlFetched: this.db.prepare(`
        UPDATE urls SET status = 'fetched', last_error = NULL, updated_at = ? WHERE url = ?
      `),
      markUrlSkipped: this.db.prepare(`
        UPDATE urls SET status = 'skipped', skip_reason = ?, lease_owner = NULL, lease_expires_at = 0, updated_at = ? WHERE url = ?
      `),
      getUrlForFail: this.db.prepare('SELECT attempts, max_attempts FROM urls WHERE url = ?'),
      urlFailRetry: this.db.prepare(`
        UPDATE urls SET status = 'queued', attempts = attempts + 1, next_attempt_at = ?,
               lease_owner = NULL, lease_expires_at = 0, last_error = ?, updated_at = ?
        WHERE url = ?
      `),
      urlFailFinal: this.db.prepare(`
        UPDATE urls SET status = 'failed', attempts = attempts + 1,
               lease_owner = NULL, lease_expires_at = 0, last_error = ?, updated_at = ?
        WHERE url = ?
      `),
      reclaimStaleUrlLeases: this.db.prepare(`
        UPDATE urls SET status = 'queued', lease_owner = NULL, lease_expires_at = 0, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at < ?
      `),
      urlCounts: this.db.prepare('SELECT status, COUNT(*) n FROM urls GROUP BY status'),
      readyUrlCount: this.db.prepare("SELECT COUNT(*) n FROM urls WHERE status = 'queued' AND next_attempt_at <= ?"),
      waitingUrlCount: this.db.prepare("SELECT COUNT(*) n, MIN(next_attempt_at) t FROM urls WHERE status = 'queued' AND next_attempt_at > ?"),
      leasedUrlCount: this.db.prepare("SELECT COUNT(*) n FROM urls WHERE status = 'leased'"),
      hasUrl: this.db.prepare('SELECT 1 FROM urls WHERE url = ? LIMIT 1'),
      requeueUrl: this.db.prepare(`
        UPDATE urls SET status = 'queued', attempts = 0, next_attempt_at = 0,
               lease_owner = NULL, lease_expires_at = 0, last_error = NULL, updated_at = ?
        WHERE url = ? AND status <> 'queued'
      `),

      upsertPage: this.db.prepare(`
        INSERT INTO pages (url, canonical_url, title, description, lang, text, content_hash, depth, fetched_at, ingest_status, updated_at)
        VALUES (@url, @canonical_url, @title, @description, @lang, @text, @content_hash, @depth, @now, 'pending', @now)
        ON CONFLICT(url) DO UPDATE SET
          canonical_url = @canonical_url, title = @title, description = @description, lang = @lang,
          text = @text, content_hash = @content_hash, depth = @depth, fetched_at = @now,
          ingest_status = 'pending', ingest_error = NULL, ingest_lease_owner = NULL, ingest_lease_expires_at = 0,
          updated_at = @now
      `),
      claimPageBatch: this.db.prepare(`
        SELECT url, canonical_url, title, description, lang, text, content_hash, depth, ingest_attempts
        FROM pages
        WHERE ingest_status = 'pending'
        ORDER BY fetched_at ASC
        LIMIT ?
      `),
      leasePage: this.db.prepare(`
        UPDATE pages SET ingest_status = 'leased', ingest_lease_owner = ?, ingest_lease_expires_at = ?, updated_at = ?
        WHERE url = ? AND ingest_status = 'pending'
      `),
      markPageDone: this.db.prepare(`
        UPDATE pages SET ingest_status = 'done', ingest_error = NULL, ingest_lease_owner = NULL, ingest_lease_expires_at = 0, updated_at = ?
        WHERE url = ?
      `),
      markPageFailed: this.db.prepare(`
        UPDATE pages SET ingest_status = ?, ingest_attempts = ingest_attempts + 1, ingest_error = ?,
               ingest_lease_owner = NULL, ingest_lease_expires_at = 0, updated_at = ?
        WHERE url = ?
      `),
      reclaimStalePageLeases: this.db.prepare(`
        UPDATE pages SET ingest_status = 'pending', ingest_lease_owner = NULL, ingest_lease_expires_at = 0, updated_at = ?
        WHERE ingest_status = 'leased' AND ingest_lease_expires_at < ?
      `),
      pageCounts: this.db.prepare('SELECT ingest_status, COUNT(*) n FROM pages GROUP BY ingest_status'),
      pendingPageCount: this.db.prepare("SELECT COUNT(*) n FROM pages WHERE ingest_status = 'pending'"),
      leasedPageCount: this.db.prepare("SELECT COUNT(*) n FROM pages WHERE ingest_status = 'leased'"),

      recordHash: this.db.prepare(`
        INSERT INTO content_hashes (hash, canonical_url, created_at) VALUES (?, ?, ?)
        ON CONFLICT(hash) DO NOTHING
      `),
      isDuplicate: this.db.prepare('SELECT canonical_url FROM content_hashes WHERE hash = ?'),

      getRobots: this.db.prepare('SELECT * FROM robots_cache WHERE host = ?'),
      saveRobots: this.db.prepare(`
        INSERT INTO robots_cache (host, body, fetched_at, ok) VALUES (@host, @body, @fetched_at, @ok)
        ON CONFLICT(host) DO UPDATE SET body = @body, fetched_at = @fetched_at, ok = @ok
      `),

      bumpCounter: this.db.prepare(`
        INSERT INTO counters (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = value + excluded.value
      `),
      getCounters: this.db.prepare('SELECT name, value FROM counters')
    };
  }

  // ─── Frontier (urls) ────────────────────────────────────────────────
  hasUrl(url) {
    return !!this.stmts.hasUrl.get(url);
  }

  /** Idempotent bulk enqueue — safe to call repeatedly with overlapping URLs. */
  enqueueMany(items, { defaultMaxAttempts = 6 } = {}) {
    const insert = this.db.transaction((rows) => {
      let inserted = 0;
      for (const it of rows) {
        const info = this.stmts.insertUrl.run({
          url: it.url,
          host: it.host || null,
          depth: it.depth || 0,
          priority: it.priority || 0,
          max_attempts: it.maxAttempts || defaultMaxAttempts,
          discovered_from: it.discoveredFrom || null,
          now: now()
        });
        if (info.changes) inserted++;
      }
      return inserted;
    });
    return insert(items);
  }

  /**
   * Forces a re-fetch of specific URLs on the next run: brand-new URLs
   * (never seen by this job) are inserted as 'queued' via enqueueMany;
   * URLs already fetched/failed/skipped are flipped back to 'queued' with
   * their attempt counter reset. Used by the periodic recrawl checker to
   * re-visit only the pages a site's own freshness signal (site-analyzer)
   * says have changed, instead of re-crawling the whole site.
   */
  requeueUrls(urls) {
    if (!urls || !urls.length) return 0;
    this.enqueueMany(urls.map((url) => ({ url, depth: 0, priority: 1000, discoveredFrom: 'recrawl' })));
    const tx = this.db.transaction((list) => {
      let requeued = 0;
      for (const url of list) {
        const info = this.stmts.requeueUrl.run(now(), url);
        if (info.changes) requeued++;
      }
      return requeued;
    });
    return tx(urls);
  }

  claimUrlBatch(n, owner, leaseMs) {
    const candidates = this.stmts.claimUrlBatch.all(now(), n);
    const claimed = [];
    const expires = now() + leaseMs;
    const tx = this.db.transaction((rows) => {
      for (const row of rows) {
        const res = this.stmts.leaseUrl.run(owner, expires, now(), row.id);
        if (res.changes) claimed.push(row);
      }
    });
    tx(candidates);
    return claimed;
  }

  markUrlFetched(url) {
    this.stmts.markUrlFetched.run(now(), url);
  }

  markUrlSkipped(url, reason) {
    this.stmts.markUrlSkipped.run(String(reason || '').slice(0, 300), now(), url);
  }

  /** Exponential backoff + jitter until max_attempts, then parked as 'failed' permanently. Isolated per URL — never stops the crawl. */
  markUrlFailed(url, { error = '', retryable = true } = {}) {
    const row = this.stmts.getUrlForFail.get(url);
    const attempts = row ? row.attempts : 0;
    const maxAttempts = row ? row.max_attempts : 6;
    const msg = String(error || '').slice(0, 500);
    if (!retryable || attempts + 1 >= maxAttempts) {
      this.stmts.urlFailFinal.run(msg, now(), url);
      return { finalFailure: true, attempts: attempts + 1 };
    }
    const backoff = Math.min(30 * 60 * 1000, 1000 * 2 ** attempts);
    const jitter = Math.floor(Math.random() * 0.3 * backoff);
    this.stmts.urlFailRetry.run(now() + backoff + jitter, msg, now(), url);
    return { finalFailure: false, attempts: attempts + 1, retryInMs: backoff + jitter };
  }

  reclaimStaleUrlLeases() {
    return this.stmts.reclaimStaleUrlLeases.run(now(), now()).changes;
  }

  urlCounts() {
    const rows = this.stmts.urlCounts.all();
    const out = { queued: 0, leased: 0, fetched: 0, failed: 0, skipped: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  readyUrlCount() { return this.stmts.readyUrlCount.get(now()).n; }
  waitingUrlRetry() {
    const row = this.stmts.waitingUrlCount.get(now());
    return { count: row.n, nextAt: row.t };
  }
  leasedUrlCount() { return this.stmts.leasedUrlCount.get().n; }

  // ─── Fetched pages / ingest queue ──────────────────────────────────
  /** Persists a fetched page BEFORE any quality evaluation — this row existing is the durability guarantee. */
  upsertPage(page) {
    this.stmts.upsertPage.run({
      url: page.url,
      canonical_url: page.canonicalUrl || page.url,
      title: page.title || '',
      description: page.description || '',
      lang: page.lang || '',
      text: page.text || '',
      content_hash: page.contentHash,
      depth: page.depth || 0,
      now: now()
    });
  }

  claimPageBatch(n, owner, leaseMs) {
    const candidates = this.stmts.claimPageBatch.all(n);
    const claimed = [];
    const expires = now() + leaseMs;
    const tx = this.db.transaction((rows) => {
      for (const row of rows) {
        const res = this.stmts.leasePage.run(owner, expires, now(), row.url);
        if (res.changes) claimed.push(row);
      }
    });
    tx(candidates);
    return claimed;
  }

  markPageDone(url) {
    this.stmts.markPageDone.run(now(), url);
  }

  /** A page's ingest failure is isolated: it never blocks other pages or the crawl. */
  markPageFailed(url, { error = '', retryable = true, maxAttempts = 5, attempts = 0 } = {}) {
    const status = retryable && attempts + 1 < maxAttempts ? 'pending' : 'failed';
    this.stmts.markPageFailed.run(status, String(error || '').slice(0, 500), now(), url);
    return { finalFailure: status === 'failed' };
  }

  reclaimStalePageLeases() {
    return this.stmts.reclaimStalePageLeases.run(now(), now()).changes;
  }

  pageCounts() {
    const rows = this.stmts.pageCounts.all();
    const out = { pending: 0, leased: 0, done: 0, failed: 0 };
    for (const r of rows) out[r.ingest_status] = r.n;
    return out;
  }

  pendingPageCount() { return this.stmts.pendingPageCount.get().n; }
  leasedPageCount() { return this.stmts.leasedPageCount.get().n; }

  // ─── Content dedup (page-level) ────────────────────────────────────
  recordContentHash(hash, canonicalUrl) {
    this.stmts.recordHash.run(hash, canonicalUrl, now());
  }

  duplicateOf(hash) {
    const row = this.stmts.isDuplicate.get(hash);
    return row ? row.canonical_url : null;
  }

  // ─── robots.txt cache ───────────────────────────────────────────────
  getRobotsCache(host) { return this.stmts.getRobots.get(host); }
  saveRobotsCache(host, body, ok) {
    this.stmts.saveRobots.run({ host, body, fetched_at: now(), ok: ok ? 1 : 0 });
  }

  // ─── Counters (chunks created/indexed, etc.) ───────────────────────
  bumpCounter(name, by = 1) {
    this.stmts.bumpCounter.run(name, by);
  }

  getCounters() {
    const rows = this.stmts.getCounters.all();
    const out = {};
    for (const r of rows) out[r.name] = r.value;
    return out;
  }

  close() {
    this.db.close();
  }
}

function dbPathForJob(jobId) {
  return path.join(JOBS_DIR, `${jobId}.sqlite`);
}

function deleteJobDb(jobId) {
  const p = dbPathForJob(jobId);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + suffix); } catch {}
  }
}

module.exports = { CrawlDb, dbPathForJob, deleteJobDb, JOBS_DIR };
