'use strict';

/**
 * storage.js — Persistenza demo/utenti (JSON based).
 *
 * UNICA fonte di loadDemos/saveDemos/loadUsers, prima duplicati in
 * server.js e chat-service.js. Lettura con cache in-memory + invalidation
 * per evitare il re-read da disco a ogni chat (collo di bottiglia attuale).
 */

const fs = require('fs');
const path = require('path');

const DEMOS_PATH = path.join(__dirname, '..', '..', 'demos.json');
const USERS_PATH = path.join(__dirname, '..', '..', 'users.json');

let _demosCache = null;
let _demosMtime = 0;
let _usersCache = null;

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch (error) {
    console.error('Error loading users.json:', error.message);
    return [];
  }
}

function loadDemos({ useCache = true } = {}) {
  try {
    const mtime = fs.existsSync(DEMOS_PATH) ? fs.statSync(DEMOS_PATH).mtimeMs : 0;
    if (useCache && _demosCache && mtime === _demosMtime) {
      return _demosCache;
    }
    const demos = JSON.parse(fs.readFileSync(DEMOS_PATH, 'utf8'));
    _demosCache = demos;
    _demosMtime = mtime;
    return demos;
  } catch (error) {
    console.error('Error loading demos.json:', error.message);
    return [];
  }
}

function saveDemos(demos) {
  try {
    fs.writeFileSync(DEMOS_PATH, JSON.stringify(demos, null, 2));
    _demosCache = demos;
    _demosMtime = fs.existsSync(DEMOS_PATH) ? fs.statSync(DEMOS_PATH).mtimeMs : 0;
  } catch (error) {
    console.error('Error saving demos.json:', error.message);
  }
}

function getDemoById(id) {
  return loadDemos().find(d => d.id === id) || null;
}

module.exports = { loadUsers, loadDemos, saveDemos, getDemoById };
