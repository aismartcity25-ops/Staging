'use strict';

/**
 * orchestrator.js — Coordina i micro-agent per un turno di chat.
 *
 * Sostituisce l'unica funzione monolitica che prima viveva in
 * chat-service.js#handleChat. Il contratto HTTP/SSE verso il widget
 * (vedi widget-src/src/widget/ChatWidget.jsx) resta IDENTICO:
 *   - stesso body di richiesta {message, sessionId, demoId, product, attachment}
 *   - stessa risposta SSE: eventi {type:'chunk', text}, {type:'done', ...},
 *     {type:'error', error}
 *   - stessa shape dell'evento `done`: {response, sessionId, citations,
 *     confidence, lowConfidence, attachment}
 *
 * Vincolo verificato sul widget: il testo mostrato viene costruito SOLO
 * accumulando gli eventi `chunk` — il campo `response` dentro `done` non
 * viene mai renderizzato. Ogni path che produce testo (incluso un rifiuto
 * del guardrail) deve quindi emetterlo via evento/i `chunk` prima del `done`.
 */

const { buildSystemPrompt } = require('./config/prompts.js');
const { resolveUploadPath } = require('./lib/uploads');
const { extractDocumentText, imageToDataUrl } = require('./lib/attachments');
const { filterHistoryForAPI } = require('./lib/chat');
const { detectLanguage } = require('./lib/tts');

// Rinforzo deterministico (euristico, no LLM) all'istruzione di lingua nel
// system prompt: gpt-4o-mini non segue sempre in modo affidabile "rispondi
// nella lingua dell'utente" quando il resto del prompt e' interamente in
// italiano (recency/majority-language bias). Un hint esplicito e mirato,
// posizionato subito prima del messaggio dell'utente, e' molto piu' efficace.
const LANGUAGE_HINT_LABELS = { en: 'inglese', de: 'tedesco', fr: 'francese', ar: 'arabo' };

const { createMemoryAgent } = require('./agents/memory-agent');
const { createDatabaseAgent } = require('./agents/database-agent');
const { createRouterAgent } = require('./agents/router-agent');
const { createRagAgent } = require('./agents/rag-agent');
const { createGuardrailAgent } = require('./agents/guardrail-agent');
const { createToolExecutorAgent } = require('./agents/tool-executor-agent');
const { createCopywriterAgent } = require('./agents/copywriter-agent');
const { createQaAgent } = require('./agents/qa-agent');

// Istanze condivise fra tutte le richieste (stesso ciclo di vita del
// vecchio `chatSessions` Map in chat-service.js).
const memory = createMemoryAgent();

/**
 * Costruisce il contenuto multimodale/testuale da inviare al modello per
 * questo turno, arricchito con l'eventuale allegato (immagine → vision,
 * documento → testo estratto). La history mantiene invece solo il
 * messaggio testuale originale (vedi orchestrateChat).
 */
async function buildApiUserContent(messageText, attachment) {
  if (attachment && attachment.kind === 'image') {
    try {
      const dataUrl = imageToDataUrl(resolveUploadPath(attachment.url), attachment.mimeType);
      return [
        { type: 'text', text: messageText },
        { type: 'image_url', image_url: { url: dataUrl } }
      ];
    } catch (err) {
      console.error('imageToDataUrl error:', err.message);
      return messageText;
    }
  }
  if (attachment && attachment.kind === 'document') {
    const docText = await extractDocumentText(resolveUploadPath(attachment.url), attachment.mimeType);
    return `${messageText}\n\n[Contenuto del documento allegato "${attachment.name}"]:\n${docText || '(non è stato possibile estrarre il testo da questo documento)'}`;
  }
  return messageText;
}

/**
 * Costruisce la risposta arricchita con citations + confidence, con
 * eventuale correzione advisory del QA agent (solo confidence/lowConfidence,
 * mai il testo o le citations).
 */
function buildChatResponse(responseText, sid, retrieval = {}, attachment = null, qaResult = null) {
  const citations = Array.isArray(retrieval.citations) ? retrieval.citations : [];
  const confidence = qaResult && typeof qaResult.confidence === 'number'
    ? qaResult.confidence
    : (typeof retrieval.confidence === 'number' ? retrieval.confidence : 0);
  const lowConfidence = citations.length === 0 || confidence < 0.3;
  return {
    success: true,
    data: { response: responseText, sessionId: sid, citations, confidence, lowConfidence, attachment: attachment || null }
  };
}

async function orchestrateChat(req, res, openai, { rag } = {}) {
  const { message, sessionId, demoId, product = 'comunicai', attachment } = req.body;

  if (!message && !attachment) {
    return res.status(400).json({ success: false, error: 'Message or attachment is required' });
  }

  const messageText = message && message.trim()
    ? message
    : (attachment && attachment.kind === 'image'
        ? 'Descrivi questa immagine e rispondi a eventuali domande su di essa.'
        : 'Analizza il contenuto di questo documento allegato.');

  console.log(`📬 Chat message:`, { demoId: demoId || '(none)', product, messageLength: messageText.length, hasAttachment: !!attachment });

  const sid = sessionId || `session_${Date.now()}`;

  const database = createDatabaseAgent();
  const router = createRouterAgent();
  const guardrail = createGuardrailAgent({ openai });
  const ragAgent = createRagAgent({ rag, openai });
  const toolExecutor = createToolExecutorAgent({ openai, ragAgent });
  const copywriter = createCopywriterAgent({ openai });
  const qa = createQaAgent({ openai });

  // ── Fase 1: attivita' indipendenti in parallelo ──────────────────
  const [guardrailResult, sessionHistory, demo, apiUserContent] = await Promise.all([
    Promise.resolve(guardrail.checkInput(messageText)),
    Promise.resolve(memory.getHistory(sid)),
    Promise.resolve(database.getDemo(demoId)),
    buildApiUserContent(messageText, attachment)
  ]);

  let customInstructions = '';
  let demoProduct = product;
  if (demo) {
    customInstructions = demo.instructions || '';
    demoProduct = demo.product || product;
    console.log(`✅ Demo loaded: ${demoId}`, { product: demoProduct, kbId: demo.knowledgeBaseId });
  }

  let systemPrompt = buildSystemPrompt(demoProduct, customInstructions);
  // NOTA: demo.instructions viene appeso di nuovo qui (duplicazione rispetto
  // a customInstructions sopra) — comportamento preesistente preservato
  // intenzionalmente: correggerlo altererebbe le risposte del modello.
  if (demo && demo.instructions) {
    systemPrompt += '\n\n' + demo.instructions;
  }

  if (attachment && attachment.kind === 'document') {
    systemPrompt += '\n\nNOTA SU ALLEGATI: l\'utente ha allegato un documento; il suo testo è stato estratto automaticamente e incluso nel messaggio utente tra parentesi quadre. Hai pieno accesso a questo contenuto: usalo direttamente per rispondere, senza mai affermare di non poter leggere allegati.';
  } else if (attachment && attachment.kind === 'image') {
    systemPrompt += '\n\nNOTA SU ALLEGATI: l\'utente ha allegato un\'immagine fornita direttamente nel messaggio in formato visivo. Hai pieno accesso a questa immagine: descrivila e rispondi alle domande su di essa senza mai affermare di non poter vedere immagini.';
  }

  const detectedLang = detectLanguage(messageText);
  const languageHintLabel = LANGUAGE_HINT_LABELS[detectedLang];

  const messagesForAPI = [
    { role: 'system', content: systemPrompt },
    ...filterHistoryForAPI(sessionHistory.slice(-9)),
    ...(languageHintLabel
      ? [{ role: 'system', content: `Promemoria: il messaggio dell'utente qui sotto sembra scritto in ${languageHintLabel}. Rispondi in ${languageHintLabel}.` }]
      : []),
    { role: 'user', content: apiUserContent }
  ];

  memory.append(sid, { role: 'user', content: messageText });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // ── Guardrail: blocco input ───────────────────────────────────────
  // Il rifiuto va inviato come evento `chunk` (non solo dentro done.response):
  // il widget costruisce il testo mostrato SOLO accumulando i `chunk`.
  if (guardrailResult.blocked) {
    sendEvent({ type: 'chunk', text: guardrailResult.refusalText });
    memory.append(sid, { role: 'assistant', content: guardrailResult.refusalText });
    const built = buildChatResponse(guardrailResult.refusalText, sid, {}, null).data;
    sendEvent({ type: 'done', ...built });
    return res.end();
  }

  const { tools: availableTools } = router.route({ demo });

  try {
    const first = await copywriter.streamTurn({
      messages: messagesForAPI,
      tools: availableTools,
      onChunk: (text) => sendEvent({ type: 'chunk', text })
    });

    if (first.finishReason === 'tool_calls' && first.toolCalls.length) {
      const assistantMessage = { role: 'assistant', content: first.text || null, tool_calls: first.toolCalls };
      const { toolResults, retrieval, attachment: generatedAttachment } = await toolExecutor.execute(first.toolCalls, { demo, languageHintLabel });

      const messagesForSecondCall = [...messagesForAPI, assistantMessage, ...toolResults];

      // Se e' stato generato un documento, il testo va sanificato (rimuovendo
      // eventuali link "sandbox:" fittizi) prima di essere mostrato: non si
      // puo' farlo chunk-per-chunk perche' andrebbe a modificare testo gia'
      // inviato, quindi in questo caso specifico si bufferizza tutto e si
      // manda un unico chunk finale invece dello streaming token-per-token.
      const bufferOnly = !!generatedAttachment;
      let finalText = '';

      const second = await copywriter.streamTurn({
        messages: messagesForSecondCall,
        onChunk: bufferOnly ? undefined : (text) => sendEvent({ type: 'chunk', text })
      });
      finalText = second.text;

      if (bufferOnly) {
        finalText = guardrail.checkOutput(finalText, { hasAttachment: true });
        sendEvent({ type: 'chunk', text: finalText });
      }

      const grounded = retrieval.empty === false;
      const qaResult = grounded
        ? await qa.review({ query: messageText, context: retrieval.context, answer: finalText })
        : null;

      memory.append(sid, { role: 'assistant', content: finalText });
      const built = buildChatResponse(finalText, sid, retrieval, generatedAttachment, qaResult).data;
      sendEvent({ type: 'done', ...built });
      return res.end();
    } else {
      memory.append(sid, { role: 'assistant', content: first.text });
      const built = buildChatResponse(first.text, sid, {}, null).data;
      sendEvent({ type: 'done', ...built });
      return res.end();
    }
  } catch (error) {
    console.error('Chat error:', error.message);
    sendEvent({ type: 'error', error: error.message || 'Errore nella comunicazione con il servizio AI' });
    return res.end();
  }
}

function clearChatSession(sessionId) {
  memory.clear(sessionId);
}

// Usata da server.js solo per arricchire /api/avatar-context (LiveAvatar)
// con spunti dagli ultimi messaggi assistant della sessione — nessuna
// scrittura, sola lettura della history già accumulata da questo modulo.
function getSessionHistory(sessionId) {
  return memory.getHistory(sessionId);
}

module.exports = { orchestrateChat, clearChatSession, getSessionHistory };
