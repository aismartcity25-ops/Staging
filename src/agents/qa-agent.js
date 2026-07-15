'use strict';

/**
 * qa-agent.js — Verifica di qualita' post-generazione (advisory-only).
 *
 * Invocato dall'orchestratore SOLO quando il turno e' "grounded" (e' stato
 * chiamato search_configured_sites). Puo' SOLO correggere il campo
 * confidence/lowConfidence dell'evento `done` finale — non tocca mai il
 * testo gia' inviato in streaming, ne' le citations: bloccare o rigenerare
 * qui non e' possibile senza rompere lo streaming token-per-token gia'
 * mostrato all'utente.
 *
 * Protetto da un timeout stretto (Promise.race): se il modello non risponde
 * in tempo, si ritorna null e l'orchestratore usa silenziosamente la
 * confidence euristica gia' calcolata dal rag-agent (nessun blocco).
 */

const MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 400;

function createQaAgent({ openai, enabled = true } = {}) {
  async function runReview({ query, context, answer }) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 20,
      messages: [
        {
          role: 'system',
          content: 'Valuti se una risposta e\' supportata dal contesto fornito. Rispondi SOLO con un numero decimale tra 0 e 1 (0 = non supportata/inventata, 1 = pienamente supportata). Nessun altro testo.'
        },
        {
          role: 'user',
          content: `CONTESTO:\n${(context || '').slice(0, 4000)}\n\nDOMANDA:\n${query}\n\nRISPOSTA DA VALUTARE:\n${answer}`
        }
      ]
    });

    const raw = response.choices[0].message.content.trim();
    const value = parseFloat(raw.replace(',', '.').match(/[\d.]+/)?.[0]);
    if (Number.isNaN(value)) return null;
    return { confidence: Math.max(0, Math.min(1, value)) };
  }

  async function review({ query, context, answer } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!enabled || !openai || !answer) return null;

    const timeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    try {
      return await Promise.race([runReview({ query, context, answer }), timeout]);
    } catch (err) {
      console.error('qa-agent review error:', err.message);
      return null;
    }
  }

  return { review };
}

module.exports = { createQaAgent };
