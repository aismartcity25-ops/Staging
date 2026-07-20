'use strict';

/**
 * tool-executor-agent.js — Dispatch/esecuzione dei tool richiesti dal
 * Copywriter (function-calling).
 *
 * Estratto dallo switch-case prima inline in chat-service.js#handleChat.
 * Differenza chiave rispetto all'originale: le tool_calls di un turno
 * vengono eseguite in Promise.all invece che in un `for` sequenziale — sono
 * gia' indipendenti tra loro (abbinate per tool_call_id), quindi eseguirle
 * in parallelo riduce la latenza totale a ~max() invece di sum() quando il
 * modello richiede piu' tool nello stesso turno (es. search_configured_sites
 * + search_websites).
 *
 * Ogni handler ritorna { content, meta? } invece di mutare un oggetto
 * `capture` esterno passato per riferimento (pattern originale in
 * chat-service.js): l'aggregazione finale (citations/confidence/attachment)
 * avviene qui, alla fine di execute().
 *
 * NOTA search_configured_sites: per una demo in modalità 'crawling' con una
 * knowledge base collegata (demo.knowledgeBaseId), si interroga prima
 * ragAgent (retrieval sull'indice vettoriale prodotto da knowledge-engine).
 * Solo se il RAG non ha nulla (KB non ancora pronta o nessun match) si
 * ricade sulla ricerca dal vivo via deep-search-engine.js — che resta anche
 * l'UNICO motore per le demo in modalità 'live' (default). deep-search-engine.js
 * restituisce contesto grezzo strutturato (non una risposta già scritta): la
 * sintesi finale avviene una sola volta, nel secondo `copywriter.streamTurn`
 * dell'orchestrator, così da non passare per due sintesi AI in sequenza.
 * Nessuna citazione/confidence reale è disponibile con questo motore:
 * `empty: true` nel meta.retrieval evita di innescare il qa-agent (che
 * altrimenti farebbe una chiamata a vuoto senza un vero contesto strutturato
 * da valutare) — il testo arriva comunque al modello.
 */

const { sendSMS, sendEmail } = require('../lib/notify');
const { textToSpeech } = require('../lib/tts');
const { generatePdf } = require('../lib/documents');
const { searchConfiguredSites: deepSearchConfiguredSites } = require('../../deep-search-engine');

async function searchWebsites(query, openai, languageHintLabel) {
  const languageInstruction = languageHintLabel
    ? `Rispondi SEMPRE in ${languageHintLabel}.`
    : 'Rispondi SEMPRE nella stessa lingua in cui è scritta la domanda dell\'utente qui sotto (es. se è in inglese rispondi in inglese, se è in tedesco rispondi in tedesco, ecc.); se la lingua non è determinabile, rispondi in italiano.';
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        { role: 'system', content: `Sei un assistente informativo. Rispondi in modo utile e preciso alla domanda dell'utente usando la tua conoscenza generale. ${languageInstruction}` },
        { role: 'user', content: query }
      ]
    });
    return { content: response.choices[0].message.content };
  } catch (error) {
    console.error('Web search error:', error.message);
    return { content: `[SYSTEM NOTE — not user-facing text: the web search failed. Tell the user${languageHintLabel ? ` in ${languageHintLabel}` : ', in the same language they used in their message,'} that no information could be found.]` };
  }
}

async function generateDocumentTool(title, content) {
  try {
    const { filename, size } = await generatePdf(title, content);
    const attachment = {
      url: `/uploads/${filename}`,
      name: `${title}.pdf`,
      mimeType: 'application/pdf',
      size,
      kind: 'document'
    };
    return {
      content: `Documento generato con successo: "${title}.pdf". Il file è già allegato al messaggio con un pulsante di download nell'interfaccia utente: nella tua risposta conferma semplicemente che il documento è pronto, senza inserire link, URL o markdown di download (non inventare URL, il download è già gestito dall'interfaccia).`,
      meta: { attachment }
    };
  } catch (err) {
    console.error('generatePdf error:', err.message);
    return { content: `Errore nella generazione del documento: ${err.message}` };
  }
}

function createToolExecutorAgent({ openai, ragAgent } = {}) {
  async function runOne(toolCall, ctx) {
    const { function: fn } = toolCall;
    let outcome;

    try {
      const parsedArgs = JSON.parse(fn.arguments);

      switch (fn.name) {
        case 'search_configured_sites': {
          const urls = (ctx.demo && Array.isArray(ctx.demo.searchUrls)) ? ctx.demo.searchUrls : [];
          const product = (ctx.demo && ctx.demo.product) || 'comunicai';
          const useRag = !!(ctx.demo && ctx.demo.searchMode === 'crawling' && ctx.demo.knowledgeBaseId);

          let text, retrieval;

          if (useRag) {
            const ragResult = await ragAgent.search(parsedArgs.query, ctx.demo, ctx.languageHintLabel);
            if (!ragResult.empty) {
              text = ragResult.text;
              retrieval = { citations: ragResult.citations, confidence: ragResult.confidence, empty: false, context: ragResult.context };
            }
          }

          // Fallback live (deep-search-engine.js): nessuna KB collegata, KB
          // ancora vuota/in indicizzazione, RAG senza match, o demo in
          // modalità 'live' (comportamento invariato).
          if (text === undefined) {
            if (urls.length === 0) {
              text = `[SYSTEM NOTE — not user-facing text: no source URLs are configured for this demo. Tell the user${ctx.languageHintLabel ? ` in ${ctx.languageHintLabel}` : ', in the same language they used in their message,'} that no information is available.]`;
            } else {
              try {
                text = await deepSearchConfiguredSites(parsedArgs.query, urls, product);
              } catch (err) {
                console.error('deep-search-engine error:', err.message);
                text = `[SYSTEM NOTE — not user-facing text: the site search failed. Tell the user${ctx.languageHintLabel ? ` in ${ctx.languageHintLabel}` : ', in the same language they used in their message,'} that no information could be found.]`;
              }
            }
            retrieval = { citations: [], confidence: 0, empty: true, context: text };
          }

          outcome = { content: text, meta: { retrieval } };
          break;
        }
        case 'search_websites':
          outcome = await searchWebsites(parsedArgs.query, openai, ctx.languageHintLabel);
          break;
        case 'send_sms':
          outcome = { content: await sendSMS(parsedArgs.phone, parsedArgs.message) };
          break;
        case 'send_email':
          outcome = { content: await sendEmail(parsedArgs.to, parsedArgs.subject, parsedArgs.message) };
          break;
        case 'text_to_speech':
          outcome = { content: await textToSpeech(parsedArgs.text, parsedArgs.voice, parsedArgs.speed, openai) };
          break;
        case 'generate_document':
          outcome = await generateDocumentTool(parsedArgs.title, parsedArgs.content);
          break;
        default:
          outcome = { content: { error: 'Tool not implemented' } };
      }
    } catch (parseError) {
      outcome = { content: { error: 'Invalid arguments' } };
    }

    return { toolCall, outcome };
  }

  async function execute(toolCalls, ctx = {}) {
    const settled = await Promise.all(toolCalls.map(tc => runOne(tc, ctx)));

    const toolResults = settled.map(({ toolCall, outcome }) => ({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: typeof outcome.content === 'string' ? outcome.content : JSON.stringify(outcome.content)
    }));

    // Se il turno ha invocato piu' volte lo stesso tool, mantieni l'ordine
    // delle toolCalls (non l'ordine di completamento) per un comportamento
    // deterministico coerente con l'esecuzione sequenziale originale.
    let retrieval = {};
    let attachment = null;
    for (const { outcome } of settled) {
      if (outcome.meta && outcome.meta.retrieval) retrieval = outcome.meta.retrieval;
      if (outcome.meta && outcome.meta.attachment) attachment = outcome.meta.attachment;
    }

    return { toolResults, retrieval, attachment };
  }

  return { execute };
}

module.exports = { createToolExecutorAgent };
