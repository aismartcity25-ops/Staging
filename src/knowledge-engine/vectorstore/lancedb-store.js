'use strict';

/**
 * vectorstore/lancedb-store.js — Storage + Retrieval stage.
 *
 * Thin adapter around the project's shared LanceDB helper
 * (src/lib/lancedb.js — provided infrastructure, left untouched). This is
 * the ONLY file in the engine that imports it, so the ingestion worker
 * depends on `insertChunks` / `loadIndexedHashes`, not on LanceDB's API
 * directly.
 *
 * The job id doubles as the LanceDB collection namespace (one table per
 * job, matching how the rest of the project already keys per-demo
 * knowledge bases), so the engine's output slots directly into the
 * existing retrieval/RAG path without that path changing at all.
 */

const lancedb = require('@lancedb/lancedb');
const { openOrCreateTable, kbDbPath } = require('../../lib/lancedb');

const MIN_VECTORS_FOR_INDEX = 256;

async function loadIndexedHashes(jobId) {
  const table = await openOrCreateTable(jobId);
  const rows = await table.query().select(['hash']).toArray();
  return new Set(rows.map((r) => r.hash));
}

/**
 * Inserts already-embedded chunk rows. Idempotent by convention: callers
 * are expected to have filtered out hashes already returned by
 * loadIndexedHashes, so re-running an interrupted job never duplicates a
 * vector for a chunk that made it in before the crash.
 */
async function insertChunks(jobId, rows) {
  if (!rows.length) return 0;
  const table = await openOrCreateTable(jobId);
  await table.add(rows);
  return rows.length;
}

/**
 * Deletes every indexed chunk for one URL. Used by the periodic recrawl
 * checker right before re-ingesting a page whose site-truth freshness
 * signal changed: insertChunks only ever adds rows, so without this the
 * old chunks for a changed page would sit alongside the new ones forever,
 * both retrievable by RAG.
 */
async function deleteChunksForUrl(jobId, url) {
  const table = await openOrCreateTable(jobId);
  const escaped = String(url).replace(/'/g, "''");
  await table.delete(`url = '${escaped}'`);
}

async function rowCount(jobId) {
  const table = await openOrCreateTable(jobId);
  try {
    return await table.countRows();
  } catch {
    return 0;
  }
}

/** Builds an HNSW-PQ index once there's enough data for it to be worth training; a no-op (exact search) below that. */
async function buildIndex(jobId) {
  const count = await rowCount(jobId);
  if (count < MIN_VECTORS_FOR_INDEX) return { built: false, count };

  const db = await lancedb.connect(kbDbPath(jobId));
  const table = await db.openTable('documents');
  await table.createIndex('vector', {
    config: lancedb.Index.hnswPq({ distanceType: 'cosine', m: 16, efConstruction: 150, numPartitions: 1 })
  });
  return { built: true, count };
}

module.exports = { loadIndexedHashes, insertChunks, deleteChunksForUrl, rowCount, buildIndex, MIN_VECTORS_FOR_INDEX };
