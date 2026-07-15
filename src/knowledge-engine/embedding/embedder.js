'use strict';

/**
 * embedding/embedder.js — Embedding stage.
 *
 * Thin adapter around the project's shared embedding client
 * (src/lib/embeddings.js — provided infrastructure, left untouched).
 * This is the ONLY file in the engine that imports it, so the rest of
 * the pipeline depends on `embedTexts(texts) -> vector[]`, not on how
 * embeddings are actually produced.
 */

const { createEmbedder } = require('../../lib/embeddings');
const { CONFIG } = require('../chunking/chunker');

function createEmbeddingStage({ openai, batchSize = 48 } = {}) {
  if (!openai) throw new Error('createEmbeddingStage: openai client richiesto');
  const embedder = createEmbedder({ openai, model: CONFIG.EMBEDDING_MODEL });

  /** Embeds a batch of chunk texts, preserving order. */
  async function embedTexts(texts) {
    const vectors = await embedder.embedBatch(texts.map((text) => ({ text })));
    return vectors;
  }

  return { embedTexts, batchSize };
}

module.exports = { createEmbeddingStage };
