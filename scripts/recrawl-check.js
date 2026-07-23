#!/usr/bin/env node
'use strict';

/**
 * scripts/recrawl-check.js — manual on-demand trigger for the periodic
 * recrawl checker (src/knowledge-engine/recrawl-checker.js). Standalone:
 * does not require the server to be running, since it only depends on
 * analyzeSite, the knowledge-engine's own job manager, and demos.json.
 *
 * Usage (run from the project root, as npm scripts always are):
 *   npm run recrawl-check -- <demoId>   — check + targeted recrawl for one demo
 *   npm run recrawl-check -- --all      — same, for every crawling-mode demo
 *
 * A manual run always re-checks the live site regardless of how recently
 * it was last checked (unlike the nightly cron, which skips demos not yet
 * due) — but still only recrawls pages actually found changed.
 */

require('dotenv').config();

const os = require('os');
const { loadDemos } = require('../src/lib/demos-store');
const { runRecrawlForDemo, runRecrawlBatch } = require('../src/knowledge-engine/recrawl-checker');

function printRecord(demo, record) {
  const label = `${demo.product}/${demo.clientUrl}`;
  console.log(`\n— ${label} (${demo.id})`);
  console.log(`  esito: ${record.outcome}${record.error ? ` (${record.error})` : ''}`);
  console.log(`  pagine controllate: ${record.pagesChecked}, cambiate: ${record.pagesChanged.length}, ricrawlate: ${record.pagesRecrawled.length}`);
  if (record.pagesChanged.length) {
    for (const p of record.pagesChanged) console.log(`    - ${p.url} (${p.lastModifiedSource}: ${p.lastModified})`);
  }
  console.log(`  durata: ${Math.round(record.durationMs / 1000)}s${record.jobStatusAfter ? `, stato job: ${record.jobStatusAfter}` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Uso: npm run recrawl-check -- <demoId>   oppure   npm run recrawl-check -- --all');
    process.exit(1);
  }

  const triggeredBy = os.userInfo().username;

  if (args[0] === '--all') {
    const records = await runRecrawlBatch({ trigger: 'manual' });
    const demos = loadDemos();
    for (const record of records) {
      const demo = demos.find((d) => d.id === record.demoId);
      if (demo) printRecord(demo, record);
    }
    console.log(`\nControllo completato su ${records.length} demo. Esiti: ${records.map((r) => r.outcome).join(', ')}`);
    console.log(`Dettaglio completo in data/knowledge-engine/recrawl-history.json`);
    return;
  }

  const demoId = args[0];
  const demo = loadDemos().find((d) => d.id === demoId);
  if (!demo) {
    console.error(`Demo non trovata: ${demoId}`);
    process.exit(1);
  }
  if (demo.searchMode !== 'crawling' || !demo.knowledgeBaseId) {
    console.error(`La demo ${demoId} non è in modalità 'crawling' (o non ha una knowledge base) — niente da controllare.`);
    process.exit(1);
  }

  const record = await runRecrawlForDemo(demo, { trigger: 'manual', triggeredBy });
  printRecord(demo, record);
  process.exit(record.outcome === 'error' ? 1 : 0);
}

main().catch((err) => {
  console.error('recrawl-check fallito:', err.stack || err.message);
  process.exit(1);
});
