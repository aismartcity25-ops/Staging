'use strict';

/**
 * jobs/job-runner.js — Runs crawl + ingestion CONCURRENTLY for one job.
 *
 * The crawler and the ingest worker are two independent loops over two
 * independent durable queues in the same per-job CrawlDb; this class just
 * starts both, lets them run at their own pace (a page is chunked,
 * embedded and indexed within moments of being fetched — never after the
 * whole crawl finishes), and waits for both to drain. Calling run() again
 * for a job that got partway through — because the process crashed, or
 * because a caller re-enqueues the same job id — resumes both queues
 * exactly where they left off; nothing is re-fetched or re-embedded that
 * already succeeded.
 */

const { EventEmitter } = require('events');
const { CrawlDb, dbPathForJob } = require('../storage/crawl-db');
const { CrawlWorker } = require('../crawler/crawler');
const { PageFetcher } = require('../crawler/fetcher');
const { IngestWorker } = require('../ingestion/ingest-worker');
const { createEmbeddingStage } = require('../embedding/embedder');
const vectorStore = require('../vectorstore/lancedb-store');

const MAX_LOG_LINES = 300;
const STATS_SNAPSHOT_MS = 3000;

class JobRunner extends EventEmitter {
  constructor(job, { openai, jobsDb, ownerId }) {
    super();
    this.job = job; // { id, seedUrls, options }
    this.jobsDb = jobsDb;
    this.ownerId = ownerId;

    this.store = new CrawlDb(dbPathForJob(job.id));
    this.fetcher = new PageFetcher({
      headless: job.options.headless,
      navigationTimeoutMs: job.options.navigationTimeoutMs,
      waitUntil: job.options.waitUntil,
      retries: job.options.fetchRetries
    });
    this.crawler = new CrawlWorker({ store: this.store, fetcher: this.fetcher, options: job.options, ownerId });
    this.embedder = createEmbeddingStage({ openai, batchSize: job.options.embedBatchSize });
    this.ingest = new IngestWorker({
      store: this.store,
      embedder: this.embedder,
      vectorStore,
      jobId: job.id,
      options: job.options,
      ownerId
    });

    this._crawlDone = false;
    this._startedAt = Date.now();
    this._logs = [];
    this._snapshotTimer = null;
    this._wireLogging();
  }

  _wireLogging() {
    const push = (level, message) => {
      this._logs.push({ t: Date.now(), level, message });
      if (this._logs.length > MAX_LOG_LINES) this._logs.shift();
    };
    this.crawler.on('log', (m) => push('info', m));
    this.crawler.on('skip', ({ url, reason }) => push('info', `skip ${url}: ${reason}`));
    this.crawler.on('error', ({ url, error, finalFailure }) => push(finalFailure ? 'error' : 'warn', `crawl ${url}: ${error}`));
    this.ingest.on('log', (m) => push('info', m));
    this.ingest.on('duplicate', ({ url, duplicateOf }) => push('info', `duplicate ${url} == ${duplicateOf}`));
    this.ingest.on('error', ({ url, error, finalFailure }) => push(finalFailure ? 'error' : 'warn', `ingest ${url}: ${error}`));
  }

  /** Graceful stop: finishes in-flight work, stops claiming new work. */
  stop() {
    this.crawler.stop();
    this.ingest.stop();
  }

  async run() {
    this._snapshotTimer = setInterval(() => {
      try {
        this.jobsDb.setStats(this.job.id, this.stats());
        // The heartbeat is also the channel cancelJob() uses to reach us
        // from another process, and proof we still hold the lease: if
        // someone else's reclaim already stole it, stop instead of
        // continuing to do work nobody will see as ours.
        const lease = this.jobsDb.heartbeat(this.job.id, this.ownerId);
        if (!lease.ok || lease.cancelRequested) this.stop();
      } catch {}
    }, STATS_SNAPSHOT_MS);

    try {
      await this.crawler.seed(this.job.seedUrls);
      const crawlPromise = this.crawler.run().then(() => { this._crawlDone = true; });
      const ingestPromise = this.ingest.run({ isCrawlDone: () => this._crawlDone });
      await Promise.all([crawlPromise, ingestPromise]);

      let index = { built: false };
      try {
        index = await vectorStore.buildIndex(this.job.id);
      } catch (e) {
        this._logs.push({ t: Date.now(), level: 'warn', message: `index build skipped: ${e.message}` });
      }

      const stats = this.stats();
      this.jobsDb.setStats(this.job.id, stats);
      return { stats, index };
    } finally {
      clearInterval(this._snapshotTimer);
      await this.fetcher.close().catch(() => {});
      this.store.close();
    }
  }

  stats() {
    const urlCounts = this.store.urlCounts();
    const pageCounts = this.store.pageCounts();
    const counters = this.store.getCounters();

    const discovered = urlCounts.queued + urlCounts.leased + urlCounts.fetched + urlCounts.failed + urlCounts.skipped;
    const elapsedMs = Date.now() - this._startedAt;
    const throughputPagesPerMin = elapsedMs > 0 ? urlCounts.fetched / (elapsedMs / 60000) : 0;
    const remaining = urlCounts.queued + urlCounts.leased;
    const etaMs = throughputPagesPerMin > 0 ? Math.round((remaining / throughputPagesPerMin) * 60000) : null;

    return {
      discoveredUrls: discovered,
      queuedUrls: urlCounts.queued,
      fetchedUrls: urlCounts.fetched,
      failedUrls: urlCounts.failed,
      skippedUrls: urlCounts.skipped,
      pagesIngested: counters.pages_ingested || 0,
      pagesDuplicate: counters.pages_duplicate || 0,
      pagesPendingIngest: pageCounts.pending,
      pagesFailedIngest: pageCounts.failed,
      chunksCreated: counters.chunks_created || 0,
      chunksIndexed: counters.chunks_indexed || 0,
      crawlComplete: this._crawlDone,
      throughputPagesPerMin: Math.round(throughputPagesPerMin * 10) / 10,
      etaMs,
      elapsedMs,
      logs: this._logs.slice(-50)
    };
  }
}

module.exports = { JobRunner };
