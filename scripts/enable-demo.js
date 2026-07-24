#!/usr/bin/env node
'use strict';

/**
 * scripts/enable-demo.js — reverses scripts/disable-demo.js: flips a demo's
 * `enabled` flag back to true so it is served again (demo.html preview and
 * the widget embedded on the client's site both start working again, no
 * data was ever lost while disabled).
 *
 * Usage:
 *   npm run enable_demo                 -> lists all demos (id, url, stato)
 *   npm run enable_demo -- <id-o-url>   -> riattiva la demo corrispondente
 *                                          (match esatto su id, altrimenti
 *                                          sottostringa case-insensitive
 *                                          su clientUrl)
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
  console.log('Uso: npm run enable_demo -- <demoId oppure sottostringa dell\'URL cliente>\n');
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
if (demo.enabled !== false) {
  console.log(`Demo ${demo.id} (${demo.clientUrl}) è già attiva — nessuna azione necessaria.`);
  process.exit(0);
}

demo.enabled = true;
saveDemos(demos);
console.log(`✓ Demo ${demo.id} (${demo.clientUrl}) riattivata.`);
