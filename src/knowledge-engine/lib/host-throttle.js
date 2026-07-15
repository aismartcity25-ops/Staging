'use strict';

const { sleep } = require('./retry');

/**
 * Per-host async semaphore: caps how many requests are in flight for a
 * given host at once, and enforces a minimum delay between request starts
 * on that host (politeness), independent of the crawler's global
 * concurrency limit.
 */
class HostThrottle {
  constructor({ maxPerHost = 2, minDelayMs = 300 } = {}) {
    this.maxPerHost = maxPerHost;
    this.minDelayMs = minDelayMs;
    this.active = new Map();
    this.lastStart = new Map();
    this.waiters = new Map();
  }

  async acquire(host) {
    const key = host || '__unknown__';
    for (;;) {
      const active = this.active.get(key) || 0;
      if (active < this.maxPerHost) {
        this.active.set(key, active + 1);
        const last = this.lastStart.get(key) || 0;
        const wait = this.minDelayMs - (Date.now() - last);
        if (wait > 0) await sleep(wait);
        this.lastStart.set(key, Date.now());
        return;
      }
      await new Promise((resolve) => {
        const list = this.waiters.get(key) || [];
        list.push(resolve);
        this.waiters.set(key, list);
      });
    }
  }

  release(host) {
    const key = host || '__unknown__';
    const active = (this.active.get(key) || 1) - 1;
    this.active.set(key, Math.max(0, active));
    const list = this.waiters.get(key);
    if (list && list.length) list.shift()();
  }
}

module.exports = { HostThrottle };
