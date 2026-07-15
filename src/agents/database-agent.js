'use strict';

/**
 * database-agent.js — Accesso alla persistenza demo (JSON storage).
 *
 * Wrapper sottile su src/lib/storage.js: unico punto da cui l'orchestratore
 * e gli altri agenti leggono i dati di una demo, cosi' e' facile sostituire
 * il backend di storage senza toccare il resto della pipeline.
 */

const { getDemoById } = require('../lib/storage');

function createDatabaseAgent() {
  function getDemo(demoId) {
    if (!demoId) return null;
    try {
      return getDemoById(demoId);
    } catch {
      return null;
    }
  }

  return { getDemo };
}

module.exports = { createDatabaseAgent };
