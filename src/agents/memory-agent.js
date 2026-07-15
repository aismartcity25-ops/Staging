'use strict';

/**
 * memory-agent.js — Storico conversazioni (in-memory).
 *
 * Stesso comportamento di oggi (Map globale, nessun TTL, nessuna
 * persistenza): estratto da chat-service.js per dare all'orchestratore
 * un'interfaccia esplicita e sostituibile (es. Fase successiva → Redis).
 */

function createMemoryAgent() {
  const sessions = new Map();

  function getHistory(sessionId) {
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    return sessions.get(sessionId);
  }

  function append(sessionId, message) {
    getHistory(sessionId).push(message);
  }

  function clear(sessionId) {
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
    }
  }

  return { getHistory, append, clear };
}

module.exports = { createMemoryAgent };
