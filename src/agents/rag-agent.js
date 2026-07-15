'use strict';

/**
 * rag-agent.js — Retrieval sulla knowledge base indicizzata di una demo.
 *
 * Incorpora la logica prima inline in chat-service.js#searchConfiguredSites:
 * messaggi di stato quando manca la KB o il retrieval e' vuoto, dedup delle
 * citazioni per URL (tenendo lo score piu' alto), calcolo confidence e
 * formattazione del blocco di contesto passato al modello.
 *
 * A differenza del codice originale, questo agente RITORNA un valore
 * invece di mutare un oggetto `capture` passato per riferimento.
 *
 * Gli URL inseriti dal commerciale sono SEMI di crawling e NON vengono MAI
 * letti direttamente dal chatbot: si interroga solo la knowledge prodotta
 * dalla pipeline crawler → ingest → index.
 */

const { createQueryPlannerAgent } = require('./query-planner-agent');

function createRagAgent({ rag, openai } = {}) {
  const queryPlanner = createQueryPlannerAgent({ openai });

  async function search(query, demo, languageHintLabel) {
    // Nota per il modello (non testo da mostrare all'utente verbatim): scritto
    // in inglese ed esplicitamente come istruzione, per evitare che il
    // modello lo ricopi alla lettera in italiano sovrascrivendo la lingua
    // dell'utente per recency bias (e' l'ultimo messaggio prima della
    // risposta finale). Se conosciamo gia' la lingua rilevata (languageHintLabel,
    // calcolata a monte nell'orchestrator), la nominiamo esplicitamente invece
    // di lasciare che il modello la ricostruisca dal resto della conversazione.
    const languageNote = languageHintLabel
      ? `Tell the user, in ${languageHintLabel}`
      : 'Tell the user, in the same language they used in their message,';

    if (!rag || !demo || !demo.knowledgeBaseId) {
      return {
        text: `[SYSTEM NOTE — not user-facing text: the knowledge base for this site is still being indexed. ${languageNote} that no information is available yet and to try again shortly.]`,
        citations: [],
        confidence: 0,
        empty: true
      };
    }

    try {
      const plannedQuery = await queryPlanner.plan(query);
      const result = await rag.retrieve(plannedQuery, demo.knowledgeBaseId, { k: 10 });

      if (!result.empty && result.context) {
        // Un singolo url sorgente puo' produrre piu' chunk nell'indice vettoriale:
        // deduplica per url (tenendo il punteggio piu' alto) cosi' la stessa fonte
        // non compare piu' volte tra le citazioni cliccabili del widget.
        const citations = Array.from(
          (result.meta || [])
            .filter(m => m && m.url)
            .map(m => ({ title: m.title || m.url, url: m.url, score: typeof m.score === 'number' ? m.score : 0 }))
            .reduce((byUrl, c) => {
              const existing = byUrl.get(c.url);
              if (!existing || c.score > existing.score) byUrl.set(c.url, c);
              return byUrl;
            }, new Map())
            .values()
        );

        const confidence = citations.length ? Math.max(...citations.map(c => c.score)) : 0;
        const fonti = citations.map(c => `- ${c.title} (${c.url})`).join('\n');

        return {
          text: `CONTESTO ESTRATTO DALL'INDICE DEL SITO:\n\n${result.context}\n\nFONTI:\n${fonti}`,
          citations,
          confidence,
          empty: false,
          context: result.context
        };
      }
    } catch (err) {
      console.error('rag.retrieve error:', err.message);
    }

    // Knowledge base vuota/non pronta: nessun fallback di lettura URL diretta.
    return {
      // Nota per il modello (non testo da mostrare all'utente verbatim) — vedi commento sopra.
      text: `[SYSTEM NOTE — not user-facing text: no relevant results were found in the indexed knowledge base for this query. ${languageNote} that you could not find information relevant to their request. Do not invent an answer.]`,
      citations: [],
      confidence: 0,
      empty: true
    };
  }

  return { search };
}

module.exports = { createRagAgent };
