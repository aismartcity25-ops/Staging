#!/usr/bin/env node
'use strict';

/**
 * scripts/disable-demo.js — flips a demo's `enabled` flag to false without
 * deleting anything: unlike DELETE /api/demos/:id (which removes the demo
 * and loses its data), this just stops it from being served. Once disabled,
 * GET /api/demos/:id and /api/demos/:id/suggestions return 404 and
 * POST /api/chat/message refuses to answer for it (see server.js and
 * src/orchestrator.js), so neither the demo.html preview nor the widget
 * embedded on the client's real site opens anymore. Fully reversible with
 * `npm run enable_demo -- <id>`.
 *
 * Usage:
 *   npm run disable_demo                 -> lists all demos (id, url, stato)
 *   npm run disable_demo -- <id-o-url>    -> disattiva la demo corrispondente
 *                                            (match esatto su id, altrimenti
 *                                            sottostringa case-insensitive
 *                                            su clientUrl)
 */

const { loadDemos, saveDemos } = require('../src/lib/demos-store');

function printList(demos) {
  if (!demos.length) { console.log('Nessuna demo trovata.'); return; }
  for (const d of demos) {
    console.log(`${d.id} | ${(d.enabled === false ? 'disattiva' : 'attiva').padEnd(9)} | ${d.clientUrl}`);
  }
}

function findMatches(demos, query) {
  const exact = demos.find(d => d.id === query);
  if (exact) return [exact];
  const q = query.toLowerCase();
  return demos.filter(d => (d.clientUrl || '').toLowerCase().includes(q));
}

const query = process.argv[2];
const demos = loadDemos();

if (!query) {
  console.log('Uso: npm run disable_demo -- <demoId oppure sottostringa dell\'URL cliente>\n');
  printList(demos);
  process.exit(0);
}

const matches = findMatches(demos, query);

if (matches.length === 0) {
  console.error(`Nessuna demo trovata per "${query}".`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`"${query}" è ambiguo, corrisponde a più demo:`);
  printList(matches);
  console.error('\nRiprova con l\'id esatto.');
  process.exit(1);
}

const demo = matches[0];
if (demo.enabled === false) {
  console.log(`Demo ${demo.id} (${demo.clientUrl}) è già disattivata — nessuna azione necessaria.`);
  process.exit(0);
}

demo.enabled = false;
saveDemos(demos);
console.log(`✓ Demo ${demo.id} (${demo.clientUrl}) disattivata. Non risponde più né in anteprima né sul sito del cliente.`);
console.log(`  Per riattivarla: npm run enable_demo -- ${demo.id}`);
