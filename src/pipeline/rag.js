'use strict';

/**
 * pipeline/rag.js — RETRIEVAL (read path), per-demo.
 *
 * Riutilizza integralmente la logica di rag.js (embed → vector search →
 * rerank → dedup → compress) ma:
 *   - legge da una tabella LanceDB PER DEMO (kbId)
 *   - apre la tabella una volta sola (cache)
 *   - condivide l'embedder (cache + throttle) con ingest
 *
 * Questo è il path PRIMARIO usato dal demo al posto del live-crawl.
 *
 * NOTA: la query rewrite (query lunga/complessa → query piu' mirata) e'
 * responsabilita' di src/agents/query-planner-agent.js, non di questo
 * modulo: retrieve() riceve la query gia' pianificata dal chiamante.
 */

const crypto = require('crypto');
const { openOrCreateTable, tableExists } = require('../lib/lancedb');
const { createEmbedder } = require('../lib/embeddings');

const CONFIG = {
  EMBEDDING_MODEL: 'text-embedding-3-small',
  OVERFETCH: 5,
  MAX_CONTEXT_CHARS: 16000,
  EMBEDDING_RETRIES: 5,
  RETRY_BASE_MS: 1500,
  CACHE_SIZE: 500
};

function createRag({ openai } = {}) {
  if (!openai) throw new Error('createRag: openai client richiesto');

  const embedder = createEmbedder({ openai, model: CONFIG.EMBEDDING_MODEL });

  // ── RERANK HELPERS (da rag.js) ─────────────────────────────────
  function keywordBoost(query, text, title = '') {
    const words = query.toLowerCase().split(/\s+/);
    const body = (text || '').toLowerCase();
    const head = (title || '').toLowerCase();
    let score = 0;
    const q = query.toLowerCase();
    if (/(prenot|visita|cup|appuntament)/i.test(q)) {
      const forbidden = /\b(patente|patenti|commissione medica locale|motorino|rinnovo patente|cml)\b/i;
      if (forbidden.test(body) || forbidden.test(head)) score -= 2.5;
    }
    for (const w of words) {
      if (w.length < 3) continue;
      if (head.includes(w)) score += 0.25;
      if (body.includes(w)) score += 0.10;
    }
    return score;
  }

  const NAV_MARKERS = ['mappa del sito', 'lavora con noi', 'note legali', 'cookie policy', 'privacy policy', 'accessibilità'];
  const FOOTER_UTILITY = ['ufficio stampa', 'dicono di noi', 'comunicati stampa', 'materiale e documenti', 'fatturazione elettronica', 'servizi di supporto tecnico', 'posta elettronica certificata'];

  function navigationPenalty(text) {
    const t = (text || '').toLowerCase();
    const navHits = NAV_MARKERS.filter(m => t.includes(m)).length;
    const fuHits = FOOTER_UTILITY.filter(m => t.includes(m)).length;
    const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
    let menuish = 0;
    for (const l of lines) {
      const body = l.replace(/^[-•·]\s*/, '');
      const short = body.length < 45;
      const titlelike = /^[A-Z0-9À-ÿ][\p{L}]*(\s[A-Z0-9À-ÿ][\p{L}]*){0,4}$/u.test(body);
      if (short && titlelike) menuish++;
    }
    const ratio = lines.length > 0 ? menuish / lines.length : 0;
    let penalty = 0;
    if (navHits >= 3 && ratio > 0.5) penalty += 1.0;
    if (fuHits >= 4 && ratio > 0.4) penalty += 0.8;
    if (ratio > 0.7) penalty += 1.0;
    else if (ratio > 0.5 && navHits >= 2) penalty += 0.4;
    return penalty;
  }

  function normalizeScore(distance) {
    if (distance === undefined || distance === null) return 0;
    return 1 / (1 + distance);
  }

  function rerank(query, results) {
    return results
      .map(r => {
        const base = normalizeScore(r._distance ?? r.score);
        const boost = keywordBoost(query, r.text, r.title);
        const lengthBoost = Math.min((r.text || '').length / 3000, 0.15);
        const navPenalty = navigationPenalty(r.text);
        return { ...r, score: base + boost + lengthBoost - navPenalty };
      })
      .sort((a, b) => b.score - a.score);
  }

  function dedupChunks(chunks) {
    const seen = new Set();
    const out = [];
    for (const chunk of chunks) {
      const id = chunk.hash || crypto.createHash('md5').update(chunk.text || '').digest('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(chunk);
    }
    return out;
  }

  function compressContext(chunks, maxChars = CONFIG.MAX_CONTEXT_CHARS) {
    let context = '';
    for (const c of chunks) {
      const block = `
[TITOLO]
${c.title || ''}

[URL]
${c.url || ''}

[CONTENUTO]
${c.text || ''}

────────────────────────────
`;
      if (context.length + block.length > maxChars) {
        const remaining = maxChars - context.length;
        if (remaining > 200) {
          const partial = block.slice(0, remaining);
          const lastBreak = partial.lastIndexOf('\n');
          if (lastBreak > 0) context += partial.slice(0, lastBreak);
        }
        break;
      }
      context += block;
    }
    return context.trim();
  }

  // ── RETRIEVE ───────────────────────────────────────────────────
  async function retrieve(query, kbId, { k = 10 } = {}) {
    if (!(await tableExists(kbId))) {
      return { context: '', meta: [], rewritten: query, empty: true, timing: {} };
    }

    const table = await openOrCreateTable(kbId);

    // `query` e' gia' la query pianificata (vedi query-planner-agent):
    // qui non c'e' piu' nessuna rewrite, solo embed → search.
    const embedStart = Date.now();
    const vector = await embedder.embed(query);
    const embeddingMs = Date.now() - embedStart;

    const candidates = await table
      .search(vector)
      .distanceType('cosine')
      .ef(50)
      .limit(k * CONFIG.OVERFETCH)
      .toArray();

    if (!candidates || candidates.length === 0) {
      return { context: '', meta: [], rewritten: query, empty: true, timing: { embeddingMs } };
    }

    let ranked = dedupChunks(rerank(query, candidates));
    const top = ranked.slice(0, k);
    const context = compressContext(top);

    const meta = top.map(item => ({
      title: item.title,
      url: item.url,
      score: item.score,
      hash: crypto.createHash('md5').update(item.text || '').digest('hex')
    }));

    return {
      context,
      meta,
      rewritten: query,
      empty: false,
      timing: { embeddingMs, retrievalMs: Date.now() - embedStart }
    };
  }

  return { retrieve, embedder, CONFIG };
}

module.exports = { createRag, CONFIG };
