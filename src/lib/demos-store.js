'use strict';

/**
 * lib/demos-store.js — shared demos.json accessor.
 *
 * Extracted from server.js so the recrawl checker (src/knowledge-engine/
 * recrawl-checker.js) and the standalone CLI (scripts/recrawl-check.js)
 * read the exact same demo list the running server does, without
 * duplicating the read logic. Read-only for those two callers — only
 * server.js's own demo CRUD routes call saveDemos.
 */

const fs = require('fs');
const path = require('path');

const DEMOS_FILE = path.join(__dirname, '..', '..', 'demos.json');

function loadDemos() {
  try   { return JSON.parse(fs.readFileSync(DEMOS_FILE, 'utf8')); }
  catch { return []; }
}

function saveDemos(demos) {
  fs.writeFileSync(DEMOS_FILE, JSON.stringify(demos, null, 2));
}

module.exports = { loadDemos, saveDemos };
