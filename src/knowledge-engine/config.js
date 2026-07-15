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
  embedBatchSize: 48
};

// How many jobs this process will run at once (each job runs its own
// crawl + ingest loops concurrently).
const MAX_CONCURRENT_JOBS = 2;

module.exports = { DEFAULT_OPTIONS, MAX_CONCURRENT_JOBS };
