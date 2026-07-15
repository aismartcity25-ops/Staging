'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter. `isRetryable(err)` decides whether an
 * error deserves another attempt at all (e.g. HTTP 404 shouldn't be
 * retried, a timeout or 503 should).
 */
async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 500,
  maxDelayMs = 20000,
  isRetryable = () => true
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const retryable = isRetryable(e);
      if (!retryable || attempt === retries) {
        e.retryable = retryable;
        throw e;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay + Math.floor(Math.random() * 0.3 * delay));
    }
  }
  throw lastErr;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

module.exports = { sleep, withRetry, withTimeout };
