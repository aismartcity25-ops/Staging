// Comandi vocali testuali - estratti dal vecchio src/services/voice-interface.js
// (rimosso: era codice morto, mai collegato al widget reale). L'input vocale
// del widget usa MediaRecorder + /api/chat/stt (vedi startVoiceInput in
// ChatWidget.jsx), quindi qui arriva già il testo trascritto da Whisper.
//
// NON ancora collegato a ChatWidget.jsx: nessun chiamante oggi invoca
// detectVoiceCommand. Tenuto per un'eventuale futura gestione di comandi
// vocali durante la registrazione (es. "ferma microfono" per interrompere
// la registrazione senza dover ricliccare il pulsante mic).

export const VOICE_COMMANDS = {
  'stop ascolto': 'stop_listening',
  'ferma microfono': 'stop_listening',
  'inizia ascolto': 'start_listening',
  'attiva microfono': 'start_listening',
  'aiuto': 'show_help',
  'help': 'show_help',
  'ripeti': 'repeat_last',
  'cancella': 'clear_chat',
  'reset': 'reset_session'
};

// Cerca una frase-comando nel testo trascritto (match "contains", non esatto,
// così "puoi ripetere?" intercetta comunque "ripeti"). Ritorna l'azione
// associata o null se il testo non corrisponde a nessun comando noto.
export function detectVoiceCommand(transcript) {
  const textLower = (transcript || '').toLowerCase().trim();
  for (const [phrase, action] of Object.entries(VOICE_COMMANDS)) {
    if (textLower.includes(phrase)) return action;
  }
  return null;
}

export function getVoiceCommandHelp() {
  return `Comandi vocali disponibili:
- "Inizia ascolto" o "Attiva microfono" - Avvia il riconoscimento vocale
- "Ferma ascolto" o "Ferma microfono" - Interrompe il riconoscimento vocale
- "Aiuto" - Mostra questa guida
- "Ripeti" - Ripete l'ultimo messaggio
- "Cancella" - Cancella la chat
- "Reset" - Resetta la sessione`;
}
