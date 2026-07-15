'use strict';

const crypto = require('crypto');

function newId(prefix) {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { newId, sha256 };
