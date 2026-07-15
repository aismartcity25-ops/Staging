'use strict';

/**
 * stt.js — Speech-To-Text condiviso (OpenAI Whisper).
 *
 * Controparte di tts.js: qui l'audio registrato dal widget (input vocale)
 * viene trascritto in testo, senza mai toccare il disco (buffer in-memory,
 * scartato subito dopo la trascrizione — a differenza degli allegati chat,
 * una registrazione vocale non ha motivo di persistere).
 */

const { toFile } = require('openai');

async function transcribeAudio(buffer, filename, mimeType, openai) {
  const file = await toFile(buffer, filename || 'voice-input.webm', { type: mimeType || 'audio/webm' });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1'
  });
  return { success: true, text: transcription.text };
}

module.exports = { transcribeAudio };
