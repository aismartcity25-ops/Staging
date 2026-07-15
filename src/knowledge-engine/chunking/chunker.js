'use strict';

/**
 * chunking/chunker.js — Chunking stage (pure functions, no I/O).
 *
 * Token-aware semantic chunking: groups paragraphs into token-bounded
 * windows (falling back to a hard token split for any single paragraph
 * too big on its own), tagged with a stable content hash so the storage
 * stage can dedupe/resume idempotently.
 *
 * This is the ONLY place quality filtering happens, and it only ever
 * drops individual chunks (too short/empty) — it never has any notion of
 * "this page" and cannot affect the crawl or the page record.
 */

const crypto = require('crypto');
const tiktoken = require('tiktoken');

const CONFIG = {
  EMBEDDING_MODEL: 'text-embedding-3-small',
  CHUNK_TOKENS: 1000,
  CHUNK_OVERLAP_TOKENS: 150,
  MIN_CHUNK_CHARS: 120,
  MAX_CHUNK_CHARS: 6000,
  // Sanity cap for pathological single-URL pages (a whole book/manual dumped
  // on one page) -- keeps embedding cost and memory bounded per page instead
  // of unbounded; the page is still indexed, just capped at its first ~400k
  // tokens of content rather than skipped or allowed to balloon indefinitely.
  MAX_CHUNKS_PER_PAGE: 400
};

let _enc = null;
function encoder() {
  if (!_enc) _enc = tiktoken.encoding_for_model(CONFIG.EMBEDDING_MODEL);
  return _enc;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tokenLength(text) {
  return encoder().encode(text).length;
}

function splitParagraphs(text) {
  return normalize(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitLargeParagraph(paragraph) {
  const enc = encoder();
  const tokens = enc.encode(paragraph);
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const slice = tokens.slice(i, i + CONFIG.CHUNK_TOKENS);
    let decoded = enc.decode(slice);
    if (decoded instanceof Uint8Array) decoded = Buffer.from(decoded).toString('utf8');
    decoded = decoded.trim();
    if (decoded.length >= CONFIG.MIN_CHUNK_CHARS) out.push(decoded);
    i += CONFIG.CHUNK_TOKENS - CONFIG.CHUNK_OVERLAP_TOKENS;
  }
  return out;
}

/** Groups paragraphs into token-bounded windows; splits any oversized paragraph on its own. */
function semanticChunk(text) {
  const paragraphs = splitParagraphs(text);
  const chunks = [];
  let current = '';

  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (tokenLength(candidate) <= CONFIG.CHUNK_TOKENS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (tokenLength(p) > CONFIG.CHUNK_TOKENS) {
      chunks.push(...splitLargeParagraph(p));
      current = '';
    } else {
      current = p;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/**
 * Quality gate — applied per chunk, never per page. A chunk that's too
 * short (nav crumbs, empty boilerplate) or absurdly long (extraction
 * failure dumping unstructured markup) is dropped; everything else
 * passes through untouched.
 */
function isQualityChunk(text) {
  return text.length >= CONFIG.MIN_CHUNK_CHARS && text.length <= CONFIG.MAX_CHUNK_CHARS;
}

/** Turns one persisted page into zero or more indexable, hash-tagged chunk rows. */
function chunkDocument(page) {
  const pieces = semanticChunk(page.text).filter(isQualityChunk).slice(0, CONFIG.MAX_CHUNKS_PER_PAGE);
  return pieces.map((text, i) => {
    const withMeta = `TITLE: ${page.title || ''}\nURL: ${page.url}\n\nCONTENT:\n${text}`.trim();
    return {
      text: withMeta,
      hash: sha256(withMeta),
      title: page.title || '',
      url: page.url,
      chunkIndex: i,
      chunkCount: pieces.length,
      createdAt: Date.now()
    };
  });
}

module.exports = { chunkDocument, semanticChunk, isQualityChunk, normalize, CONFIG };
