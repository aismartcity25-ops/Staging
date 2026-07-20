'use strict';

/**
 * router-agent.js — Decide quali tool sono disponibili per il turno.
 *
 * Euristico (nessuna chiamata LLM): la decisione e' un semplice booleano su
 * demo.searchUrls (escludi search_websites quando la demo ha siti sorgente
 * configurati, per evitare che il modello preferisca la conoscenza generale
 * alla ricerca dal vivo/RAG sul sito del cliente). Lo stesso tool
 * search_configured_sites copre sia la modalita' 'live' che 'crawling' — la
 * scelta fra RAG e ricerca live avviene dentro tool-executor-agent.js in base
 * a demo.searchMode/demo.knowledgeBaseId, non qui. send_sms/send_email
 * restano disattivati perche' userebbero le stesse credenziali Twilio del
 * canale WhatsApp, che resta volutamente scollegato per ora.
 */

const { getToolsForDemo } = require('../lib/tools');

const DISABLED_TOOLS = new Set(['send_sms', 'send_email']);

function createRouterAgent() {
  function route({ demo } = {}) {
    const hasConfiguredUrls = !!(demo && Array.isArray(demo.searchUrls) && demo.searchUrls.length > 0);
    const tools = getToolsForDemo(hasConfiguredUrls).filter(t => !DISABLED_TOOLS.has(t.function.name));
    return { tools };
  }

  return { route };
}

module.exports = { createRouterAgent };
