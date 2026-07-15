'use strict';

/**
 * ingestion/ingest-worker.js — Chunking -> Embedding -> Storage, streaming.
 *
 * Consumes the `pages` table as a durable, lease-based queue: every page
 * the crawler persists shows up here with ingest_status='pending' and
 * gets processed independently of crawl progress — a page is embedded
 * and searchable within moments of being fetched, not after the whole
 * site finishes. Isolated per-page failures (bad HTML, embedding API
 * hiccup) never stop the crawl and never stop other pages from being
 * ingested; they retry with backoff like any other queue item.
 *
 * Idempotent: chunk hashes already present in the vector store (loaded
 * once at start, refreshed as we insert) are never re-embedded or
 * re-inserted, so resuming after a crash — or re-running the same job —
 * never duplicates a vector.
 */

const { EventEmitter } = require('events');
const { sleep } = require('../lib/retry');
const { chunkDocument } = require('../chunking/chunker');

// Each chunk is up to ~1000 tokens (chunking/chunker.js CHUNK_TOKENS) plus a
// small title/url prefix; 100 chunks keeps a batch safely under OpenAI's
// per-request token cap even for the largest pages.
const MAX_CHUNKS_PER_EMBED_BATCH = 100;

class IngestWorker extends EventEmitter {
  constructor({ store, embedder, vectorStore, jobId, options, ownerId }) {
    super();
    this.store = store;
    this.embedder = embedder;
    this.vectorStore = vectorStore;
    this.jobId = jobId;
    this.options = options;
    this.ownerId = ownerId;
    this._stopRequested = false;
    this._seenChunkHashes = null; // Set, lazily loaded from the vector store
  }

  stop() {
    this._stopRequested = true;
  }

  async _seenHashes() {
    if (!this._seenChunkHashes) {
      this._seenChunkHashes = await this.vectorStore.loadIndexedHashes(this.jobId);
    }
    return this._seenChunkHashes;
  }

  /**
   * Runs until the crawl is done and the page queue is fully drained (or
   * stop() is called). `isCrawlDone()` lets the job runner signal "no
   * more pages will ever be added" without this worker needing to know
   * anything about the crawler.
   */
  async run({ isCrawlDone }) {
    let inFlight = 0;
    const inFlightPromises = new Set();

    for (;;) {
      if (this._stopRequested) {
        if (inFlight === 0) break;
        await Promise.race(inFlightPromises);
        continue;
      }

      this.store.reclaimStalePageLeases();

      const freeSlots = Math.max(0, this.options.ingestConcurrency - inFlight);
      const claimed = freeSlots > 0
        ? this.store.claimPageBatch(freeSlots, this.ownerId, this.options.leaseMs)
        : [];

      if (claimed.length === 0 && inFlight === 0) {
        const pending = this.store.pendingPageCount();
        const leased = this.store.leasedPageCount();
        if (isCrawlDone() && pending === 0 && leased === 0) break; // nothing left, and nothing more coming
        await sleep(this.options.pollMs);
        continue;
      }

      for (const page of claimed) {
        inFlight++;
        const p = this._processPage(page)
          .catch((e) => this.emit('log', `unexpected error ingesting ${page.url}: ${e.message}`))
          .finally(() => {
            inFlight--;
            inFlightPromises.delete(p);
          });
        inFlightPromises.add(p);
      }

      await sleep(this.options.pollMs);
    }

    if (inFlightPromises.size) await Promise.all(inFlightPromises);
    this.emit('ingest-complete');
  }

  async _processPage(page) {
    try {
      const duplicateOf = this.store.duplicateOf(page.content_hash);
      if (duplicateOf && duplicateOf !== page.canonical_url) {
        this.store.markPageDone(page.url);
        this.store.bumpCounter('pages_duplicate', 1);
        this.emit('duplicate', { url: page.url, duplicateOf });
        return;
      }
      this.store.recordContentHash(page.content_hash, page.canonical_url || page.url);

      const chunks = chunkDocument({
        url: page.canonical_url || page.url,
        title: page.title,
        text: page.text
      });
      this.store.bumpCounter('chunks_created', chunks.length);

      const seen = await this._seenHashes();
      const fresh = chunks.filter((c) => !seen.has(c.hash));

      // A single very large page (a full manual dumped on one URL, say)
      // can produce hundreds of chunks; embedding them in one API call
      // risks exceeding OpenAI's per-request token cap. Batching here
      // keeps every page's chunks embeddable regardless of page size, and
      // makes a huge page's chunks searchable incrementally rather than
      // all-or-nothing.
      for (let i = 0; i < fresh.length; i += MAX_CHUNKS_PER_EMBED_BATCH) {
        const batch = fresh.slice(i, i + MAX_CHUNKS_PER_EMBED_BATCH);
        const vectors = await this.embedder.embedTexts(batch.map((c) => c.text));
        const rows = batch.map((c, idx) => ({
          vector: vectors[idx],
          text: c.text,
          title: c.title,
          url: c.url,
          site: '',
          hash: c.hash,
          chunkIndex: c.chunkIndex,
          chunkCount: c.chunkCount,
          createdAt: c.createdAt
        }));
        await this.vectorStore.insertChunks(this.jobId, rows);
        for (const c of batch) seen.add(c.hash);
        this.store.bumpCounter('chunks_indexed', rows.length);
      }

      this.store.markPageDone(page.url);
      this.store.bumpCounter('pages_ingested', 1);
      this.emit('page-ingested', { url: page.url, chunks: chunks.length, indexed: fresh.length });
    } catch (e) {
      const info = this.store.markPageFailed(page.url, {
        error: e.message,
        retryable: true,
        attempts: page.ingest_attempts || 0
      });
      this.emit('error', { url: page.url, error: e.message, finalFailure: info.finalFailure });
    }
  }
}

module.exports = { IngestWorker };
