'use strict';

const robotsParser = require('robots-parser');
const { withRetry, withTimeout } = require('../lib/retry');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * robots.txt gate, backed by the per-job CrawlDb so a fetched robots.txt
 * survives a restart instead of being re-fetched on every resume.
 */
class RobotsGate {
  constructor(store, { userAgent = 'KnowledgeEngineBot', ttlMs = DEFAULT_TTL_MS, fetchTimeoutMs = 8000 } = {}) {
    this.store = store;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this._mem = new Map(); // host -> parsed robots instance (per-process cache)
  }

  async _fetch(host) {
    const robotsUrl = `https://${host}/robots.txt`;
    try {
      return await withRetry(
        async () => {
          const t = withTimeout(this.fetchTimeoutMs);
          try {
            const res = await fetch(robotsUrl, { signal: t.signal });
            if (!res.ok) return { body: null, ok: false };
            return { body: await res.text(), ok: true };
          } finally {
            t.clear();
          }
        },
        { retries: 2, baseDelayMs: 500 }
      );
    } catch {
      return { body: null, ok: false };
    }
  }

  async _load(host) {
    if (this._mem.has(host)) return this._mem.get(host);

    const cached = this.store.getRobotsCache(host);
    const fresh = cached && Date.now() - cached.fetched_at < this.ttlMs;

    let body, ok;
    if (fresh) {
      body = cached.body;
      ok = !!cached.ok;
    } else {
      const res = await this._fetch(host);
      body = res.body;
      ok = res.ok;
      this.store.saveRobotsCache(host, body, ok);
    }

    const parsed = body && ok ? robotsParser(`https://${host}/robots.txt`, body) : null;
    this._mem.set(host, parsed);
    return parsed;
  }

  async isAllowed(url) {
    try {
      const host = new URL(url).hostname;
      const robots = await this._load(host);
      if (!robots) return true; // no robots.txt / unreachable -> allow
      return robots.isAllowed(url, this.userAgent) !== false;
    } catch {
      return true;
    }
  }

  async getSitemaps(url) {
    try {
      const host = new URL(url).hostname;
      const robots = await this._load(host);
      if (!robots || typeof robots.getSitemaps !== 'function') return [];
      return robots.getSitemaps() || [];
    } catch {
      return [];
    }
  }
}

module.exports = { RobotsGate };
