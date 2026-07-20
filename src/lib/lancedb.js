'use strict';

/**
 * lib/lancedb.js — shared LanceDB helper.
 *
 * One LanceDB database directory per knowledge base (kbId == knowledge-engine
 * job id == demo.knowledgeBaseId), each containing a single `documents`
 * table. Used by both the ingestion write path
 * (knowledge-engine/vectorstore/lancedb-store.js) and the RAG read path
 * (pipeline/rag.js), so both sides agree on where a demo's vectors live and
 * what shape they are.
 */

const path = require('path');
const lancedb = require('@lancedb/lancedb');
const { Schema, Field, FixedSizeList, Float32, Float64, Int32, Utf8 } = require('apache-arrow');

const EMBEDDING_DIM = 1536; // text-embedding-3-small
const TABLE_NAME = 'documents';
const DB_ROOT = path.join(__dirname, '..', '..', 'data', 'knowledge-engine', 'lancedb');

const SCHEMA = new Schema([
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
  new Field('text', new Utf8(), false),
  new Field('title', new Utf8(), true),
  new Field('url', new Utf8(), true),
  new Field('site', new Utf8(), true),
  new Field('hash', new Utf8(), false),
  new Field('chunkIndex', new Int32(), true),
  new Field('chunkCount', new Int32(), true),
  new Field('createdAt', new Float64(), true)
]);

function kbDbPath(kbId) {
  return path.join(DB_ROOT, String(kbId));
}

const _connections = new Map(); // kbId -> Promise<Connection>
const _tables = new Map(); // kbId -> Promise<Table>

function getConnection(kbId) {
  const key = String(kbId);
  if (!_connections.has(key)) {
    _connections.set(key, lancedb.connect(kbDbPath(key)));
  }
  return _connections.get(key);
}

/** True iff this knowledge base has ever been created (even if still empty). */
async function tableExists(kbId) {
  try {
    const db = await getConnection(kbId);
    const names = await db.tableNames();
    return names.includes(TABLE_NAME);
  } catch {
    return false;
  }
}

/** Opens the `documents` table for a knowledge base, creating it (empty, schema-only) on first use. Cached per kbId. */
async function openOrCreateTable(kbId) {
  const key = String(kbId);
  if (_tables.has(key)) return _tables.get(key);

  const promise = (async () => {
    const db = await getConnection(key);
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) return db.openTable(TABLE_NAME);
    return db.createEmptyTable(TABLE_NAME, SCHEMA);
  })();

  _tables.set(key, promise);
  try {
    return await promise;
  } catch (e) {
    _tables.delete(key); // don't cache a failed open/create attempt
    throw e;
  }
}

module.exports = { openOrCreateTable, tableExists, kbDbPath, TABLE_NAME, EMBEDDING_DIM };
