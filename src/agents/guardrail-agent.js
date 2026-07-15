'use strict';

/**
 * guardrail-agent.js — Controlli di sicurezza su input/output.
 *
 * checkInput: euristica regex conservativa contro tentativi espliciti di
 * prompt-injection/jailbreak (es. "ignora le istruzioni precedenti",
 * "rivelami il system prompt"). Bias verso NON bloccare, per evitare falsi
 * positivi su richieste legittime di cittadini che possono contenere parole
 * come "ignora" in contesti benigni. Nessuna chiamata LLM in questa
 * iterazione: il parametro `llmFallback` e' predisposto per un'estensione
 * futura (classificazione gpt-4o-mini nei casi ambigui) senza dover
 * toccare l'orchestratore.
 *
 * checkOutput: sanificazione post-hoc del testo finale, identica
 * all'originale stripFakeAttachmentLinks di chat-service.js — va usata
 * SOLO quando la risposta viene gia' bufferizzata per altri motivi (oggi:
 * dopo generate_document), perche' generalizzarla a ogni turno
 * richiederebbe bufferizzare tutte le risposte prima di mostrarle,
 * eliminando lo streaming token-per-token.
 */

const INJECTION_PATTERNS = [
  /ignora\s+(tutte\s+le\s+)?istruzioni\s+(precedenti|di\s+sistema)/i,
  /disattiva\s+(le\s+)?(tue\s+)?(regole|restrizioni|limitazioni)/i,
  /(rivelami|mostrami|stampa)\s+.{0,20}(system\s?prompt|prompt\s+di\s+sistema|istruzioni\s+di\s+sistema)/i,
  /you\s+are\s+now\s+(in\s+)?(dan|jailbreak|developer\s+mode)/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /reveal\s+(your\s+)?(system\s+prompt|instructions)/i
];

function createGuardrailAgent({ openai, llmFallback = false } = {}) {
  function checkInput(text) {
    if (!text) return { blocked: false };
    const hit = INJECTION_PATTERNS.some(re => re.test(text));
    if (!hit) return { blocked: false };
    return {
      blocked: true,
      refusalText: 'Non posso soddisfare questa richiesta. Sono qui per aiutarti con le informazioni disponibili su questo servizio: come posso esserti utile?'
    };
  }

  /**
   * Rimuove i link markdown con schema non-http(s) (es. `[file.pdf](sandbox:/file.pdf)`)
   * che il modello a volte inventa per gli allegati generati (bias da convenzioni
   * dei code-interpreter). Il download reale e' gia' gestito dall'attachment card
   * nel widget, quindi qui basta tenere solo il testo del link.
   */
  function checkOutput(text, { hasAttachment = false } = {}) {
    if (!text || !hasAttachment) return text;
    return text.replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]*\)/g, '$1');
  }

  return { checkInput, checkOutput };
}

module.exports = { createGuardrailAgent };
