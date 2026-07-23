'use strict';

const DEFAULT_OPTIONS = {
  // Crawl. The HTTP-first fetcher (crawler/fetcher.js) makes most pages
  // cheap to fetch, so the budget below is sized for "deep knowledge of
  // an institutional/business site" rather than a token sample -- while
  // still bounded so a much larger site (e-commerce catalog, docs portal)
  // can't turn into an unbounded crawl. Callers that know they need more
  // can override maxDepth/maxPages per job.
  maxDepth: 5,
  maxPages: 500,
  crawlConcurrency: 8,
  hostConcurrency: 3,
  politenessMs: 250,
  navigationTimeoutMs: 25000,
  waitUntil: 'domcontentloaded',
  fetchRetries: 3,
  headless: true,
  sameSiteOnly: true,
  userAgent: 'KnowledgeEngineBot',

  // Shared lease/poll tuning (crawl frontier + ingest queue)
  leaseMs: 5 * 60 * 1000,
  pollMs: 250,

  // Ingestion
  ingestConcurrency: 3,
  embedBatchSize: 48,

  // Priority: news/press-style pages (lib/url.js#isNewsLikePath) are
  // deprioritized by this much so the maxPages budget favors stable
  // reference content (services/offices/hours) first — see
  // crawler/crawler.js. Large enough to always sort a news page after
  // every non-news page at the same discovery tier (seed/sitemap/link).
  newsLikePriorityPenalty: 500,

  // Priority: bare-ID download links (lib/url.js#isLikelyNonPagePath,
  // e.g. /media/1891) are deprioritized by this much — larger than
  // newsLikePriorityPenalty so a sitemap listing thousands of these
  // alongside real content pages can't bury the real pages behind them.
  nonPagePathPriorityPenalty: 2000
};

// How many jobs this process will run at once (each job runs its own
// crawl + ingest loops concurrently).
const MAX_CONCURRENT_JOBS = 2;

module.exports = { DEFAULT_OPTIONS, MAX_CONCURRENT_JOBS };
