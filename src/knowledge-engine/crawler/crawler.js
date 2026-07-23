'use strict';

/**
 * crawler/crawler.js — Crawl orchestration.
 *
 * Sole responsibility: discover URLs and extract pages. It never judges
 * content quality and never drops a page for being "thin" — every page
 * that fetches successfully is persisted (storage/crawl-db.js `pages`
 * table) before anything downstream looks at it. Quality filtering, if
 * any, happens later, per-chunk, in the ingestion stage.
 *
 * State (frontier, fetched pages, robots cache) lives entirely in the
 * per-job CrawlDb, so run() can be called again after a crash/restart and
 * it will resume from exactly where it left off instead of starting over.
 */

const { EventEmitter } = require('events');
const { normalizeUrl, hostOf, sameSite, isNewsLikePath, isLikelyNonPagePath } = require('../lib/url');
const { HostThrottle } = require('../lib/host-throttle');
const { sleep } = require('../lib/retry');
const { RobotsGate } = require('./robots');
const { discoverSitemapUrls } = require('./sitemap');
const { extractDocument } = require('../extraction/document');
const { sha256 } = require('../lib/ids');

class CrawlWorker extends EventEmitter {
  constructor({ store, fetcher, options, ownerId }) {
    super();
    this.store = store;
    this.fetcher = fetcher;
    this.options = options;
    this.ownerId = ownerId;
    this.throttle = new HostThrottle({ maxPerHost: options.hostConcurrency, minDelayMs: options.politenessMs });
    this.robots = new RobotsGate(store, { userAgent: options.userAgent });
    this._stopRequested = false;
    this._allowedHosts = new Set();
  }

  stop() {
    this._stopRequested = true;
  }

  /**
   * Queues the seed URLs plus anything discoverable from their sitemaps.
   * Idempotent (enqueueMany dedupes on URL) — safe to call again on
   * resume, it just won't re-insert what's already in the frontier.
   *
   * Seeds are queued exactly as given, never filtered by robots.txt or
   * any policy heuristic: an operator-supplied seed is an explicit
   * instruction to fetch that URL. The only reason a seed is skipped is
   * if it can't structurally become an HTTP(S) request at all.
   */
  async seed(seedUrls) {
    const seedItems = [];
    for (const raw of seedUrls) {
      const normalized = normalizeUrl(raw);
      if (!normalized) continue;
      const host = hostOf(normalized);
      if (host) this._allowedHosts.add(host);
      seedItems.push({ url: normalized, host, depth: 0, priority: 1000, discoveredFrom: 'seed' });
    }
    const inserted = this.store.enqueueMany(seedItems);
    this.emit('log', `seeded ${seedItems.length} url(s), ${inserted} new`);

    for (const item of seedItems) {
      let sitemapUrls = [];
      try {
        sitemapUrls = await discoverSitemapUrls(new URL(item.url).origin, {
          robots: this.robots,
          log: (m) => this.emit('log', m)
        });
      } catch {}
      if (!sitemapUrls.length) continue;

      const items = [];
      for (const raw of sitemapUrls) {
        const n = normalizeUrl(raw);
        if (n && this._inScope(n)) items.push({ url: n, host: hostOf(n), depth: 0, priority: this._priorityFor(n, 100), discoveredFrom: 'sitemap' });
      }
      const sitemapInserted = this.store.enqueueMany(items);
      this.emit('log', `sitemap discovered ${items.length} url(s) for ${item.url} (${sitemapInserted} new)`);
    }
  }

  /** Applies the news/press and bare-ID-download deprioritizations (config.js) on top of a discovery-tier base priority. Never applied to seeds (see seed() doc comment). */
  _priorityFor(url, basePriority) {
    let priority = basePriority;
    if (isNewsLikePath(url)) priority -= this.options.newsLikePriorityPenalty;
    if (isLikelyNonPagePath(url)) priority -= this.options.nonPagePathPriorityPenalty;
    return priority;
  }

  _inScope(url) {
    if (this.options.sameSiteOnly === false) return true;
    const host = hostOf(url);
    if (!host) return false;
    for (const allowed of this._allowedHosts) {
      if (sameSite(host, allowed)) return true;
    }
    return false;
  }

  /**
   * Runs until the frontier is empty (or stop() is called). Safe to call
   * again after an interruption — it picks up whatever is still queued
   * or was left leased by a worker that died mid-request.
   */
  async run() {
    let inFlight = 0;
    const inFlightPromises = new Set();

    for (;;) {
      if (this._stopRequested) {
        if (inFlight === 0) break;
        await Promise.race(inFlightPromises);
        continue;
      }

      this.store.reclaimStaleUrlLeases();

      const fetchedSoFar = this.store.urlCounts().fetched;
      const budgetLeft = Math.max(0, this.options.maxPages - fetchedSoFar - inFlight);
      if (budgetLeft === 0) {
        if (inFlight === 0) break; // page budget reached, nothing in flight -- stop claiming new work
        await Promise.race(inFlightPromises);
        continue;
      }

      const freeSlots = Math.max(0, Math.min(this.options.crawlConcurrency - inFlight, budgetLeft));
      const claimed = freeSlots > 0 ? this.store.claimUrlBatch(freeSlots, this.ownerId, this.options.leaseMs) : [];

      if (claimed.length === 0 && inFlight === 0) {
        const { count: waiting, nextAt } = this.store.waitingUrlRetry();
        const leased = this.store.leasedUrlCount();
        if (waiting === 0 && leased === 0) break; // frontier truly exhausted
        await sleep(Math.max(50, Math.min((nextAt || Date.now()) - Date.now(), 5000)));
        continue;
      }

      for (const item of claimed) {
        inFlight++;
        const p = this._processUrl(item)
          .catch((e) => this.emit('log', `unexpected error processing ${item.url}: ${e.message}`))
          .finally(() => {
            inFlight--;
            inFlightPromises.delete(p);
          });
        inFlightPromises.add(p);
      }

      await sleep(this.options.pollMs);
    }

    if (inFlightPromises.size) await Promise.all(inFlightPromises);
    this.emit('crawl-complete', this.store.urlCounts());
  }

  async _processUrl(item) {
    const { url, depth, host } = item;
    const isSeed = item.discovered_from === 'seed' && depth === 0;
    this.emit('visit', { url, depth });

    if (!isSeed && !(await this.robots.isAllowed(url))) {
      this.store.markUrlSkipped(url, 'robots.txt');
      this.emit('skip', { url, reason: 'robots.txt' });
      return;
    }

    const effectiveHost = host || hostOf(url) || 'unknown';
    await this.throttle.acquire(effectiveHost);
    let result;
    try {
      result = await this.fetcher.fetch(url, {
        timeoutMs: this.options.navigationTimeoutMs,
        retries: this.options.fetchRetries
      });
    } finally {
      this.throttle.release(effectiveHost);
    }

    if (!result.ok) {
      if (result.status === 429) this.throttle.reportRateLimited(effectiveHost);
      const info = this.store.markUrlFailed(url, { error: result.error, retryable: result.retryable });
      this.emit('error', { url, error: result.error, finalFailure: info.finalFailure });
      return; // isolated failure -- the crawl keeps going
    }
    this.throttle.reportSuccess(effectiveHost);

    const doc = extractDocument(result.html, result.finalUrl || url);
    const contentHash = sha256(doc.text || '');

    // Persisted BEFORE any quality evaluation: once a page is fetched it
    // exists, full stop. Nothing downstream can make it disappear.
    this.store.upsertPage({
      url: doc.url,
      canonicalUrl: doc.canonicalUrl,
      title: doc.title,
      description: doc.description,
      lang: doc.lang,
      text: doc.text,
      contentHash,
      depth
    });
    this.store.markUrlFetched(url);
    this.emit('page', { url: doc.url, depth });

    if (depth + 1 <= this.options.maxDepth) {
      const items = [];
      for (const link of doc.links) {
        if (!this._inScope(link)) continue;
        items.push({ url: link, host: hostOf(link), depth: depth + 1, priority: this._priorityFor(link, 0), discoveredFrom: doc.url });
      }
      if (items.length) this.store.enqueueMany(items);
    }

    this.emit('progress', this.stats());
  }

  stats() {
    return this.store.urlCounts();
  }
}

module.exports = { CrawlWorker };
