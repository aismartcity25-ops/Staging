'use strict';

const { sleep } = require('./retry');

/**
 * Per-host async semaphore: caps how many requests are in flight for a
 * given host at once, and enforces a minimum delay between request starts
 * on that host (politeness), independent of the crawler's global
 * concurrency limit.
 *
 * The delay is adaptive: reportRateLimited() doubles it (starting at
 * rateLimitStepMs) every time the host answers 429, up to maxDelayMs, so a
 * host that starts throttling us gets progressively more breathing room
 * instead of being hit by hostConcurrency parallel requests forever.
 * reportSuccess() halves it back down, so a host that was never rate-
 * limiting us (the common case) stays at the fast default, and one that
 * stops doing so ramps back to full speed within a few requests instead
 * of staying slow indefinitely.
 */
class HostThrottle {
  constructor({ maxPerHost = 2, minDelayMs = 300, maxDelayMs = 30000, rateLimitStepMs = 2000 } = {}) {
    this.maxPerHost = maxPerHost;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.rateLimitStepMs = rateLimitStepMs;
    this.active = new Map();
    this.lastStart = new Map();
    this.waiters = new Map();
    this.penalties = new Map(); // host -> extra delay (ms) on top of minDelayMs
  }

  async acquire(host) {
    const key = host || '__unknown__';
    for (;;) {
      const active = this.active.get(key) || 0;
      if (active < this.maxPerHost) {
        this.active.set(key, active + 1);
        const last = this.lastStart.get(key) || 0;
        const delay = this.minDelayMs + (this.penalties.get(key) || 0);
        const wait = delay - (Date.now() - last);
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

  /** Call after a 429 from this host: doubles its extra delay (capped at maxDelayMs). */
  reportRateLimited(host) {
    const key = host || '__unknown__';
    const current = this.penalties.get(key) || 0;
    this.penalties.set(key, Math.min(this.maxDelayMs, current > 0 ? current * 2 : this.rateLimitStepMs));
  }

  /** Call after a non-429 response from this host: halves its extra delay, ramping back to full speed. */
  reportSuccess(host) {
    const key = host || '__unknown__';
    const current = this.penalties.get(key) || 0;
    if (current > 0) this.penalties.set(key, current < 100 ? 0 : Math.floor(current / 2));
  }
}

module.exports = { HostThrottle };
