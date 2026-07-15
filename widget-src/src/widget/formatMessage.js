// Formattazione contenuto messaggi - porting 1:1 della logica originale,
// esteso con il riconoscimento di email/telefono/indirizzi (roadmap contatti).

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Il gruppo opzionale di asterischi intorno all'etichetta tollera il caso in
// cui il modello scriva l'etichetta in grassetto markdown (es. "**Indirizzo:**").
// Tre punti opzionali per gli asterischi di grassetto: prima dell'etichetta,
// subito dopo la parola (es. "**Indirizzo**:") o dopo i due punti
// (es. "**Indirizzo:**") - il markdown bold puo' chiudersi in punti diversi.
// L'etichetta e' ancorata all'inizio riga (con eventuale bullet "•"/"-")
// cosi' non scatta su un uso colloquiale della parola a meta' frase, come
// "il sito e' accessibile all'indirizzo: https://...".
const PHONE_LABEL_REGEX = /(^[ \t]*(?:[•-]\s*)?\*{0,2}(?:Telefono|Tel\.?|Cellulare|Cell\.?|Fax)\*{0,2}\s*:\s*\*{0,2})([+\d][\d\s./-]{5,}\d)/gim;
const ADDRESS_LABEL_REGEX = /(^[ \t]*(?:[•-]\s*)?\*{0,2}(?:Indirizzo|Sede|Ubicazione)\*{0,2}\s*:\s*\*{0,2})(?!@@CWLINK|https?:\/\/)([^\n<]+)/gim;

// "Indirizzo: Piazza X, 1, Citta" -> etichetta invariata + link Google Maps colorato.
function linkifyAddresses(text) {
  return text.replace(ADDRESS_LABEL_REGEX, (match, label, address) => {
    const trimmed = address.trim();
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
    return `${label}<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="chatbot__entity chatbot__entity--address" title="Apri su Google Maps">${trimmed}</a>`;
  });
}

// "Telefono: 0521 823219" -> etichetta invariata + link tel: colorato.
function linkifyPhones(text) {
  return text.replace(PHONE_LABEL_REGEX, (match, label, number) => {
    const dial = number.replace(/[^\d+]/g, '');
    return `${label}<a href="tel:${dial}" class="chatbot__entity chatbot__entity--phone" title="Chiama">${number.trim()}</a>`;
  });
}

// Indirizzi email ovunque nel testo -> link mailto: colorato.
function linkifyEmails(text) {
  return text.replace(EMAIL_REGEX, (email) => {
    return `<a href="mailto:${email}" class="chatbot__entity chatbot__entity--email" title="Invia email">${email}</a>`;
  });
}

// Placeholder usato per proteggere i link markdown gia' convertiti dalle
// trasformazioni successive (linkify indirizzi/telefoni/email, bold, ecc.).
// Marker testuale semplice, improbabile in una risposta reale del chatbot.
function linkToken(i) {
  return `@@CWLINK${i}@@`;
}

export function formatMessage(content) {
  if (!content) return content;

  // Titoli markdown ("### Titolo", "## Titolo", ecc.) -> testo in grassetto,
  // ripulito dai cancelletti: il modello a volte li usa nonostante le
  // istruzioni del prompt di non farlo, e vanno comunque ripuliti.
  let result = content.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');

  // Link markdown con schema mailto:/tel: -> solo l'indirizzo/numero (testo
  // semplice): i passaggi linkifyEmails/linkifyPhones piu' sotto lo
  // trasformano poi nell'entita' cliccabile con lo stile giusto. Va fatto
  // PRIMA del passaggio http(s) qui sotto, che non riconosce questi schemi.
  result = result.replace(/\[([^\]]+)\]\((?:mailto|tel):[^\s)]+\)/gi, (match, text) => text);

  // Link in stile markdown (http/https) -> placeholder, PRIMA di ogni altra
  // trasformazione. Se convertissimo prima gli URL nudi, l'URL dentro
  // "[testo](url)" verrebbe gia' avvolto in un <a>, rompendo questo match e
  // lasciando sia "[testo]" sia il link duplicato nell'output. L'etichetta
  // "[testo]" viene scartata: deve comparire solo il link (mai testo seguito
  // dal link tra parentesi).
  const linkPlaceholders = [];
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, text, url) => {
    linkPlaceholders.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return linkToken(linkPlaceholders.length - 1);
  });

  // Converte gli URL nudi rimanenti in link.
  const urlRegex = /(?<!href=")(https?:\/\/[^\s<>"']+)/g;
  result = result.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  // Indirizzi, telefoni ed email -> link cliccabili colorati per tipo.
  result = linkifyAddresses(result);
  result = linkifyPhones(result);
  result = linkifyEmails(result);

  // Grassetto markdown -> <strong>.
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Newline -> <br>.
  result = result.replace(/\n/g, '<br>');

  // Ripristina i link markdown protetti all'inizio.
  result = result.replace(/@@CWLINK(\d+)@@/g, (match, i) => linkPlaceholders[Number(i)]);

  return result;
}

// Rileva un intento "come si raggiunge X" nella domanda utente o un
// indirizzo esplicito nella risposta AI, per mostrare un mini embed Maps.
// Basato su radici lessicali (non forme verbali esatte) per coprire le
// diverse coniugazioni ("raggiungo", "raggiunge", "raggiungere", ecc.).
const DIRECTION_INTENT_REGEX = /\b(raggiung\w*|arriv\w*|indicazioni\w*|percorso)\b|dove\s+si\s+trova/i;
const PLACE_FROM_QUESTION_REGEX = /(?:raggiung\w*|arriv\w*|vad[oa]|vai)\s+(?:a|al|allo|alla|ai|agli|alle|presso|in|il|lo|la)?\s*([^?.\n]+)/i;

export function extractMapQuery(userText = '', aiText = '') {
  if (!DIRECTION_INTENT_REGEX.test(userText) && !DIRECTION_INTENT_REGEX.test(aiText)) {
    return null;
  }

  const addressMatch = aiText.match(/^[ \t]*(?:[•-]\s*)?\*{0,2}(?:Indirizzo|Sede|Ubicazione)\*{0,2}\s*:\s*\*{0,2}(?!https?:\/\/)([^\n<]+)/im);
  if (addressMatch) return addressMatch[1].trim().replace(/\.$/, '');

  const placeMatch = userText.match(PLACE_FROM_QUESTION_REGEX);
  if (placeMatch) return placeMatch[1].trim();

  return null;
}
