'use strict';

/**
 * crawler/fetcher.js — Fetches a page's rendered HTML.
 *
 * HTTP-first, browser-fallback: most institutional/business sites (the
 * kind this product builds demos from) are server-rendered plain HTML,
 * so a bare HTTP GET gets the real content in a few hundred milliseconds
 * with none of the overhead — or bot-detection surface — of spinning up
 * a full Chromium page per URL. Puppeteer is only used when the plain
 * fetch didn't yield usable content (JS-rendered shell, or the plain
 * fetch got blocked) or non-2xx that a browser might get past. This
 * keeps crawls both faster (more pages indexed per minute -> deeper
 * knowledge within the same page budget) and less likely to trip a
 * site's rate limiting than blasting every request through a full
 * browser, while still handling SPA-style sites correctly.
 *
 * The Puppeteer browser instance is shared and lazily launched (and
 * transparently relaunched if it crashes/disconnects) so the rest of the
 * crawler never has to know a browser is involved at all.
 */

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const { withRetry, withTimeout } = require('../lib/retry');

const ABORT_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const ABORT_URL_PATTERN = /\.(pdf|zip|doc|docx|xls|xlsx|rar|7z)(\?|$)/i;
const MIN_HTTP_TEXT_CHARS = 200; // below this, assume the page needs JS rendering
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function quickTextLength(html) {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().length;
  } catch {
    return 0;
  }
}

class PageFetcher {
  constructor({
    headless = true,
    navigationTimeoutMs = 25000,
    httpTimeoutMs = 12000,
    waitUntil = 'domcontentloaded',
    retries = 3
  } = {}) {
    this.headless = headless;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.httpTimeoutMs = httpTimeoutMs;
    this.waitUntil = waitUntil;
    this.retries = retries;
    this.browser = null;
    this._launching = null;
  }

  async _ensureBrowser() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this._launching) return this._launching;
    this._launching = puppeteer
      .launch({
        headless: this.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu']
      })
      .then((browser) => {
        this.browser = browser;
        this._launching = null;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      });
    return this._launching;
  }

  /**
   * Fetch one URL. Never throws — failures come back as
   * `{ ok: false, error, retryable }` so the caller can persist the
   * outcome without a try/catch around every call site.
   */
  async fetch(url, { timeoutMs = this.navigationTimeoutMs, retries = this.retries } = {}) {
    const httpResult = await this._fetchHttp(url, { retries });
    if (httpResult.ok && quickTextLength(httpResult.html) >= MIN_HTTP_TEXT_CHARS) {
      return httpResult;
    }
    if (httpResult.ok === false && httpResult.retryable === false) {
      return httpResult; // definitive failure (404, non-html, ...) -- a browser won't fix that
    }

    // Either the plain fetch didn't return enough text (likely a
    // JS-rendered page) or it failed in a way a real browser might get
    // past (blocked, rate-limited, needs cookies/JS challenge).
    return this._fetchBrowser(url, { timeoutMs, retries });
  }

  async _fetchHttp(url, { retries = this.retries } = {}) {
    try {
      let lastStatus = null;
      const result = await withRetry(
        async () => {
          const t = withTimeout(this.httpTimeoutMs);
          try {
            const res = await fetch(url, {
              redirect: 'follow',
              signal: t.signal,
              headers: {
                'User-Agent': BROWSER_UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              }
            });
            lastStatus = res.status;
            if (res.status >= 500 || res.status === 429) {
              const e = new Error(`HTTP ${res.status}`);
              e.retryable = true;
              e.status = res.status;
              throw e;
            }
            if (res.status >= 400) {
              const e = new Error(`HTTP ${res.status}`);
              e.retryable = false;
              e.status = res.status;
              throw e;
            }
            const contentType = res.headers.get('content-type') || '';
            if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
              const e = new Error(`non-html content-type: ${contentType}`);
              e.retryable = false;
              throw e;
            }
            return { html: await res.text(), finalUrl: res.url || url };
          } finally {
            t.clear();
          }
        },
        { retries, baseDelayMs: 800, isRetryable: (e) => e.retryable !== false }
      );
      return { ok: true, html: result.html, finalUrl: result.finalUrl };
    } catch (e) {
      return { ok: false, error: e.message, retryable: e.retryable !== false, status: e.status ?? lastStatus };
    }
  }

  async _fetchBrowser(url, { timeoutMs = this.navigationTimeoutMs, retries = this.retries } = {}) {
    const browser = await this._ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(BROWSER_UA);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        const rurl = req.url().toLowerCase();
        if (ABORT_RESOURCE_TYPES.has(type) || ABORT_URL_PATTERN.test(rurl) || rurl.startsWith('mailto:')) {
          return req.abort();
        }
        req.continue();
      });

      try {
        await withRetry(
          async () => {
            const response = await page.goto(url, { waitUntil: this.waitUntil, timeout: timeoutMs });
            if (response) {
              const status = response.status();
              if (status >= 500 || status === 429) {
                const e = new Error(`HTTP ${status}`);
                e.retryable = true;
                e.status = status;
                throw e;
              }
              if (status >= 400) {
                const e = new Error(`HTTP ${status}`);
                e.retryable = false;
                e.status = status;
                throw e;
              }
            }
          },
          { retries, baseDelayMs: 1000, isRetryable: (e) => e.retryable !== false }
        );
      } catch (e) {
        return { ok: false, error: e.message, retryable: e.retryable !== false, status: e.status };
      }

      const finalUrl = page.url();
      const contentType = await page.evaluate(() => document.contentType || '').catch(() => '');
      if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
        return { ok: false, error: `non-html content-type: ${contentType}`, retryable: false };
      }

      const html = await page.content();
      return { ok: true, html, finalUrl };
    } catch (e) {
      return { ok: false, error: e.message, retryable: true };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
  }
}

module.exports = { PageFetcher };
