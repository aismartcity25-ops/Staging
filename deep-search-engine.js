/**
 * ============================================================
 * DEEP SEARCH ENGINE — v2.0
 * Motore di ricerca completo con crawling ricorsivo guidato dalla
 * rilevanza della query, scraping HTML, ricerca mirata via Firecrawl.
 *
 * Compatibile con ComunicAI e MedicAI.
 * Usa: axios, cheerio, firecrawl (SDK Node ufficiale).
 * ============================================================
 *
 * ARCHITETTURA:
 *
 *  searchConfiguredSites(query, urls, product)
 *       │
 *       ├─ FASE 1+2 (in parallelo tra loro, e per ogni root URL):
 *       │
 *       │    Deep Crawler — coda a priorità (best-first), non BFS
 *       │    cieco: seed iniziale da sitemap.xml/robots.txt (se
 *       │    disponibile) + link scoperti navigando, ordinati per
 *       │    rilevanza alla query (anchor-text + slug URL) prima di
 *       │    ogni fetch, fino a MAX_DEPTH livelli. Si ferma prima
 *       │    (early-stop) su pagine realmente pertinenti alla query, non
 *       │    sulla prima pagina lunga — quante pagine pertinenti servono
 *       │    dipende dalla domanda: 1 se breve/semplice, altrimenti
 *       │    EARLY_STOP_CONVERGING_HITS pagine convergenti (per non perdere
 *       │    completezza sulla prima corrispondenza), nessun early-stop per
 *       │    le domande più complesse (strategy 'comprehensive').
 *       │    Da ogni pagina estrae: testo, link, telefoni, email,
 *       │    indirizzi (incluso nav/footer), titoli h1/h2/h3, meta.
 *       │    Budget per root URL: ≤ queryAnalysis.estimatedTime
 *       │    (5-15s, vedi analyzeQuery).
 *       │
 *       │    Firecrawl (se configurato) — ricerca mirata sul dominio
 *       │    (includeDomains) con scraping incluso delle pagine trovate
 *       │    (scrapeOptions: markdown): risultati arricchiti con
 *       │    contenuto reale, non solo snippet. Timeout allineato al
 *       │    budget della query (5-15s), non al timeout di singola
 *       │    pagina — una ricerca che scrapa più pagine richiede più
 *       │    tempo di un semplice fetch.
 *       │
 *       ├─ FASE 3: Context Assembly
 *       │    Assembla tutto il testo raccolto in un contesto
 *       │    strutturato (titoli, headings, telefoni, email,
 *       │    indirizzi, snippet, link), troncato a MAX_CONTEXT_CHARS.
 *       │    NON sintetizza una risposta qui: la sintesi con AI
 *       │    avviene UNA SOLA VOLTA, a valle, nell'orchestrator
 *       │    (src/orchestrator.js), che è l'unico punto a conoscere
 *       │    persona/istruzioni personalizzate/lingua dell'utente —
 *       │    farlo anche qui produrrebbe una doppia sintesi ridondante
 *       │    e una risposta finale "riscritta due volte".
 *       │
 *       └─ GARANTITO: non restituisce mai un contesto vuoto. Se il
 *                     crawl e Firecrawl falliscono entrambi, restituisce
 *                     comunque una stringa esplicativa così l'AI a
 *                     valle può rispondere con conoscenza generale +
 *                     link al sito, invece di una risposta vuota.
 */

'use strict';

const axios  = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const { Firecrawl } = require('firecrawl');

// Client HTTP dedicato con connessioni keep-alive, scoped a questo file (non
// tocca `axios.defaults` globale, usato da altri moduli del progetto). Di
// default Node NON riusa la connessione TCP/TLS tra due axios.get() separate,
// nemmeno verso lo stesso host: ognuna paga il proprio handshake da zero. In
// un crawl che fa decine di richieste allo stesso sito (fino a MAX_PAGES_PER_SITE)
// riusare le connessioni evita handshake TCP+TLS ripetuti. maxSockets un po'
// sopra CONCURRENCY per non introdurre code interne all'agent; keepAliveMsecs
// più lungo del default (1000ms) per sopravvivere anche tra un messaggio di
// chat e il successivo sullo stesso sito.
//
// NOTA: è stato provato anche un DNS caching lato client (`cacheable-lookup`,
// resolver basato su c-ares con cache). Scartato dopo un test diretto: fallisce
// con ESERVFAIL proprio su un dominio reale usato nei test (comune.maranello.mo.it),
// mentre la risoluzione DNS nativa del sistema operativo funziona senza problemi
// sullo stesso host. Dato che questo motore deve girare su siti client arbitrari
// con configurazioni DNS imprevedibili, il rischio di rompere una demo per un
// problema di risoluzione supera il guadagno di latenza — non vale la pena.
const keepAliveAgentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 };
const httpClient = axios.create({
  httpAgent:  new http.Agent(keepAliveAgentOpts),
  httpsAgent: new https.Agent(keepAliveAgentOpts)
});

// Client Firecrawl per FASE 2 (ricerca supplementare) — sostituisce SerpAPI,
// rivelatasi inaffidabile nei test (timeout frequenti su entrambe le query).
// Usa il proprio client HTTP interno all'SDK, non il keep-alive sopra.
const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

// ─── Costanti configurabili ───────────────────────────────────────────────────

const MAX_PAGES_PER_SITE   = 60;   // Massimo pagine da visitare per sito
const MAX_DEPTH            = 5;    // Profondità massima crawling (root=0, figlio=1, nipote=2, bis=3, tris=4, quad=5)
const PAGE_TIMEOUT_MS      = 8000; // Timeout per ogni fetch
const CONCURRENCY          = 6;    // Richieste HTTP parallele per batch (più pagine valutate nello stesso budget di tempo, senza ridurre l'ampiezza del crawl)
const MAX_CONTEXT_CHARS    = 14000; // Massimo caratteri di contesto da passare all'AI
const CACHE_TTL_MS         = 60 * 60 * 1000; // Cache pagine/sitemap 1 ora (era 15 min): l'uso tipico è un commerciale che mostra la stessa demo più volte nell'arco della giornata — un TTL più lungo taglia drasticamente la latenza delle demo ripetute, con rischio di contenuto stantio trascurabile per siti istituzionali (comunque azzerata ad ogni riavvio del server, non è un indice persistente)
const RELEVANCE_EARLY_STOP_SCORE = 10; // Punteggio scorePageRelevance oltre il quale una pagina è considerata "trovata"
const MIN_CONTENT_CHARS    = 300;  // Guardia minima di contenuto per l'early-stop (evita pagine cortissime keyword-stuffed)
const EARLY_STOP_CONVERGING_HITS = 3; // Domande non semplici (ma non "comprehensive"): quante pagine devono superare RELEVANCE_EARLY_STOP_SCORE prima di potersi fermare — richiede evidenza convergente da più pagine, non basta la prima corrispondenza, per non perdere in completezza rispetto all'early-stop "a una pagina" delle domande semplici
const EARLY_STOP_GRACE_BATCHES = 2; // Quante batch extra concedere dopo aver raggiunto EARLY_STOP_CONVERGING_HITS, prima di fermarsi davvero: le pagine "categoria" che fanno scattare la soglia spesso non contengono i dettagli specifici (telefono/orari), che vivono in una loro pagina figlia — vedi childScoreBonus in adaptiveSearch
const SITEMAP_TIMEOUT_MS   = 3000; // Timeout per singola richiesta di discovery sitemap/robots (la discovery gira in background, non blocca più il crawl)

// ─── Cache in-memory ─────────────────────────────────────────────────────────

const pageCache = new Map();  // url → { text, links, ts }
const sitemapCache = new Map(); // origin → { urls, ts } — evita di rifare robots.txt/sitemap.xml (+ figlie) ad ogni query sullo stesso sito

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { map.delete(key); return null; }
  return entry.data;
}
function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
}

// ─── Analisi query per strategia adattiva ─────────────────────────────────────

async function analyzeQuery(query) {
  const startTime = Date.now();
  const tokens = tokenize(query);
  const hasContactInfo = tokens.some(t => ['telefono', 'email', 'indirizzo', 'orari', 'orario'].includes(t));
  const hasServiceName = tokens.some(t => ['servizio', 'prenotazione', 'appuntamento', 'documenti'].includes(t));
  const hasSpecificInfo = tokens.some(t => ['costo', 'prezzo', 'validità', 'scadenza', 'requisiti'].includes(t));
  const isSimpleQuestion = query.length < 50;
  const complexityScore = (hasContactInfo ? 1 : 0) + (hasServiceName ? 1 : 0) + (hasSpecificInfo ? 1 : 0) + (isSimpleQuestion ? 0 : 1);
  const estimatedTime = Math.min(5000 + (complexityScore * 3000), 15000); // Tempo stimato in base alla complessità
  return {
    complexity: complexityScore,
    strategy: complexityScore <= 1 ? 'targeted' : (complexityScore <= 2 ? 'adaptive' : 'comprehensive'),
    hasContactInfo,
    hasServiceName,
    hasSpecificInfo,
    isSimpleQuestion,
    estimatedTime,
    tokens,
    timeElapsed: Date.now() - startTime
  };
}

// ─── Utility: normalizza URL ──────────────────────────────────────────────────

function normalizeUrl(base, href) {
  try {
    if (!href) return null;
    href = href.trim();
    // Rimuovi attributi HTML aggiuntivi in modo più generico
    href = href.replace(/\s+target\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*rel\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*onclick\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*class\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*id\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*style\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*title\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.replace(/\s*data-[^=\s]+\s*=\s*["'][^"']*["']\s*/gi, ' ');
    href = href.trim();
    
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
    const url = new URL(href, base);
    url.hash = '';               // rimuovi frammenti
    return url.href.replace(/\/$/, ''); // rimuovi trailing slash
  } catch {
    return null;
  }
}

// ─── Utility: pulizia URL specifica per contesto ──────────────────────────────

function cleanUrlForContext(url) {
  if (!url) return null;
  // Rimuovi eventuali attributi HTML residui
  let cleaned = url.replace(/\s+target\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*rel\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*onclick\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*class\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*id\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*style\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*title\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.replace(/\s*data-[^=\s]+\s*=\s*["'][^"']*["']\s*/gi, ' ');
  cleaned = cleaned.trim();
  
  // Assicurati che sia un URL valido
  try {
    const urlObj = new URL(cleaned);
    return urlObj.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
function getHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function isSameDomain(urlA, urlB) {
  try {
    const hA = new URL(urlA).hostname.replace(/^www\./, '');
    const hB = new URL(urlB).hostname.replace(/^www\./, '');
    return hA === hB;
  } catch { return false; }
}

// ─── Utility: estrazione testo da HTML ───────────────────────────────────────

function extractPageData(html, pageUrl) {
  const $ = cheerio.load(html);

  // Cattura il testo di nav/footer/header/aside PRIMA di rimuoverli: sui siti
  // istituzionali telefono/email/orari vivono spesso lì (anche in header o
  // in un widget di sidebar). Va usato SOLO per l'estrazione contatti
  // (fullText più sotto), non per rawText/scoring, per non introdurre
  // rumore di navigazione nel contenuto principale. header/aside sono stati
  // aggiunti qui insieme all'estensione della lista di rimozione sotto —
  // senza catturarli prima, un contatto messo in un header/sidebar sarebbe
  // sparito anche da fullText, non solo da rawText.
  const navFooterText = $('nav, footer, header, aside').text().replace(/\s+/g, ' ').trim();

  // Estrai link interni (per il crawler) PRIMA di rimuovere nav/footer: su molti
  // siti istituzionali il menu principale (es. "Servizi" → "Anagrafe e stato
  // civile") vive proprio dentro <nav>, e link utili (mappa del sito, contatti)
  // dentro <footer>. Estrarli dopo la rimozione (comportamento originale)
  // scartava la maggioranza dei link reali del sito — su un caso osservato,
  // 47 link su 66 (12 in <nav> + 35 in <footer>) sparivano prima ancora di
  // essere visti dal crawler.
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const resolved = normalizeUrl(pageUrl, href);
    if (resolved && isSameDomain(resolved, pageUrl)) {
      links.push(resolved); // Restituisci solo l'URL nudo
    }
  });

  // Link con testo (per output utile all'utente e per lo scoring anchor-text)
  const namedLinks = [];
  $('a[href]').each((i, el) => {
    if (i > 60) return;
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const resolved = normalizeUrl(pageUrl, href);
    if (resolved && text.length > 3 && !resolved.match(/\.(jpg|jpeg|png|gif|pdf|ico|css|js|woff)/i)) {
      namedLinks.push({ text, url: resolved }); // Salva sia testo che URL
    }
  });

  // Titolo/meta description PRIMA della rimozione sotto: alcuni siti mettono
  // l'unico <h1> di pagina dentro un <header> semantico (non solo il nav del
  // sito), quindi estrarli dopo aver rimosso `header` (vedi lista estesa
  // sotto) rischierebbe di lasciare title vuoto su quei siti.
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';
  const metaDesc = $('meta[name="description"]').attr('content') || '';

  // Rimuovi elementi non utili (solo dal testo/scoring: link, contatti e
  // title/meta sono già estratti sopra). Lista estesa rispetto alla versione
  // precedente (solo `.cookie-banner, #cookie, .popup`): sui siti
  // istituzionali il rumore da banner cookie/breadcrumb/social/sidebar aveva
  // un peso enorme sul testo grezzo — osservato direttamente nei test, dove
  // frasi come "Quanto sono chiare le informazioni su questa pagina? Valuta
  // da 1 a 5 stelle..." finivano ripetute più volte nel contesto mandato
  // all'AI, a scapito di contenuto utile entro MAX_CONTEXT_CHARS.
  $([
    'script', 'style', 'noscript', 'iframe', 'svg', 'img', 'video', 'audio',
    'nav', 'footer', 'header', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.cookie-banner', '#cookie', '.popup', '.cookie', '.cookies', '.cookie-consent',
    '.breadcrumb', '.breadcrumbs', '.social-share', '.share-buttons',
    '.ads', '.advertisement'
  ].join(', ')).remove();

  // Estrai tutti i testi dalle sezioni principali. NOTA: `body` non va nella
  // stessa selezione di `main, article, section...` — body contiene per
  // definizione anche il testo già catturato da quei tag più specifici, e
  // includerlo qui duplicava il contenuto (stesso paragrafo ripetuto due
  // volte nel rawText, osservato nei test). `body` resta solo come fallback
  // sotto, per le pagine senza contenitori semantici riconoscibili.
  const textParts = [];
  $('main, article, section, .content, #content, .main-content, [role="main"]').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 50) textParts.push(t);
  });

  // Se non trova sezioni principali, prendi tutto il body
  if (textParts.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText) textParts.push(bodyText);
  }

  const rawText = textParts.join(' ').substring(0, 8000);

  // Estrai headings significativi (struttura della pagina)
  const headings = [];
  $('h1, h2, h3').each((i, el) => {
    if (i > 30) return;
    const t = $(el).text().trim();
    if (t.length > 3) headings.push(t);
  });

  // Estrai contatti (include nav/footer, catturati sopra prima della rimozione)
  const fullText = rawText + ' ' + $('body').text() + ' ' + navFooterText;

  const phones = [...new Set(
    (fullText.match(/(?:\+39[\s.-]?)?(?:0\d{1,4}[\s.-]?\d{5,8}|3\d{2}[\s.-]?\d{6,7}|800[\s.-]?\d{5,6})/g) || [])
      .map(p => p.replace(/\s+/g, '').trim())
      .filter(p => p.replace(/\D/g,'').length >= 9)
  )].slice(0, 10);

  const emails = [...new Set(
    (fullText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
  )].slice(0, 10);

  // NOTA ReDoS: la versione precedente usava [A-Za-zÀ-ú\s']+\s* — la classe
  // quantificata include \s e viene subito seguita da un altro \s*, quantificatori
  // adiacenti che matchano gli stessi caratteri in più modi diversi. Su testo
  // lungo senza un CAP valido a seguire (comune nelle pagine "amministrazione
  // trasparente", dense di prosa) questo causa backtracking catastrofico e blocca
  // il processo per decine di secondi/minuti. Riscritta con parole separate da
  // spazio esplicite (nessuna sovrapposizione tra quantificatori) e un tetto al
  // numero di parole nel nome via, per restare lineare anche su input patologico.
  const addresses = [...new Set(
    (fullText.match(/(?:Via|Piazza|Corso|Viale|Strada|Largo|Vicolo)\s+[A-Za-zÀ-ú']+(?:\s[A-Za-zÀ-ú']+){0,6}\s*,?\s*\d+[a-zA-Z]?,?\s*\d{5}/gi) || [])
      .map(a => a.trim())
  )].slice(0, 5);

  // Estrazione orari di apertura: pattern euristico, non un parser di orari
  // completo (stessa filosofia delle regex sopra) — cattura da un giorno
  // della settimana fino alla prima fascia oraria che segue. Tre varianti,
  // verificate su siti reali (municipale e ospedaliero) durante lo sviluppo,
  // dove le prime due da sole mancavano sistematicamente il formato "prosa"
  // molto comune sui siti sanitari:
  //   1. "lunedì... 8:30-13:00"              (trattino ASCII, stile comunale)
  //   2. "lunedì... dalle ore 8:00 alle ore 18:00" (prosa, stile ospedaliero)
  //   3. "lunedì – venerdì, 10:30 – 20:00"    (trattino tipografico – / —)
  // Nessun contesto extra dopo la fascia oraria: un giorno con doppia fascia
  // (mattina+pomeriggio) cattura solo la prima — limite noto, preferibile a
  // uno snippet troncato a metà numero (il "." è anche il separatore
  // ore/minuti nel formato italiano "8.30", quindi non si può usare "fino al
  // prossimo punto" come terminatore senza tagliare a metà orari come
  // "sabato: 8.30-12.30"). Quantificatori tutti delimitati ({0,N}) per
  // restare lineari anche su input patologico (vedi nota ReDoS sopra).
  const DAY_NAMES = 'luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica';
  const openingHours = [...new Set([
    ...(fullText.match(new RegExp(`(?:${DAY_NAMES})[^.\\n]{0,150}?\\d{1,2}[:.]\\d{2}\\s*-\\s*\\d{1,2}[:.]\\d{2}`, 'gi')) || []),
    ...(fullText.match(new RegExp(`(?:${DAY_NAMES})[^.\\n]{0,80}?dalle\\s+(?:ore\\s+)?\\d{1,2}[:.]\\d{2}\\s+alle\\s+(?:ore\\s+)?\\d{1,2}[:.]\\d{2}`, 'gi')) || []),
    ...(fullText.match(new RegExp(`(?:${DAY_NAMES})[^.\\n]{0,150}?\\d{1,2}[:.]\\d{2}\\s*[–—]\\s*\\d{1,2}[:.]\\d{2}`, 'gi')) || [])
  ].map(s => s.replace(/\s+/g, ' ').trim()))].slice(0, 5);

  return { title, metaDesc, rawText, headings, links, namedLinks, phones, emails, addresses, openingHours, pageUrl };
}

// ─── Fetch di una singola pagina, con retry veloce e cache ────────────────────

/**
 * Fetcha una pagina HTML e la mette in cache — condivisa tra il batch fetch
 * di adaptiveSearch e prefetchRootPages (vedi sotto), per non duplicare la
 * stessa logica fetch+extract+cache in due posti.
 *
 * Un solo retry, veloce, e SOLO su errori di rete/timeout (nessuna risposta
 * ricevuta dal server — `!err.response`): un 404/403 non migliora
 * ritentando. Molti fallimenti osservati nei test erano timeout/errori
 * transitori di rete, non pagine realmente irraggiungibili — un retry con
 * timeout più corto recupera questi casi senza rischiare di sforare il
 * budget della query (mai più del timeout originale, floor 500ms sotto il
 * quale non vale la pena ritentare).
 */
async function fetchAndCachePage(url, timeoutMs) {
  const cached = cacheGet(pageCache, url);
  if (cached) return cached;

  const requestOpts = {
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0; +https://assistant.local)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
    },
    // Accetta solo HTML
    validateStatus: s => s >= 200 && s < 400
  };

  let resp;
  try {
    resp = await httpClient.get(url, { ...requestOpts, timeout: timeoutMs });
  } catch (err) {
    if (err.response) throw err; // errore applicativo (4xx/5xx): ritentare non aiuta
    const retryTimeout = Math.min(timeoutMs, 3000);
    if (retryTimeout < 500) throw err; // budget troppo risicato per un retry
    resp = await httpClient.get(url, { ...requestOpts, timeout: retryTimeout });
  }

  const contentType = (resp.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('html')) return null;

  const pageData = extractPageData(resp.data, url);
  cacheSet(pageCache, url, pageData);
  return pageData;
}

// ─── FASE 1: Ricerca Adattiva ─────────────────────────────────────────────────

/**
 * Ricerca adattiva che inizia con strategia mirata e aumenta la depth solo se necessario.
 * La coda è a priorità (best-first): ogni candidato ha uno `score` di rilevanza
 * rispetto alla query (da sitemap/robots.txt come seed, o da anchor-text/slug URL
 * dei link scoperti) e viene processata dal punteggio più alto al più basso, non
 * in ordine di scoperta — così entro il budget di tempo limitato vengono fetchate
 * per prime le pagine più probabilmente pertinenti.
 * Restituisce un array di oggetti { title, rawText, headings, phones, emails, addresses, pageUrl }
 */
async function adaptiveSearch(rootUrl, queryAnalysis, maxTime = 15000) {
  const startTime = Date.now();
  const visited = new Set();
  const queue = [{ url: normalizeUrl(rootUrl, rootUrl) || rootUrl, depth: 0, strategy: 'targeted', score: Infinity }];
  const results = [];
  let currentDepth = 0;
  let foundEnough = false;
  let relevantHits = 0; // conta le pagine che superano RELEVANCE_EARLY_STOP_SCORE, per l'early-stop "a evidenza convergente" delle domande non semplici (vedi sotto)
  let graceBatchesLeft = null; // null = soglia non ancora raggiunta; altrimenti quante batch extra restano prima di fermarsi davvero (vedi sotto)

  // Strategie di ricerca per livello di profondità
  const strategies = {
    0: 'targeted',    // Pagina principale + sezioni chiave
    1: 'expanded',    // Sotto-pagine principali
    2: 'comprehensive', // Sezione completa
    3: 'deep',        // Sotto-sezioni
    4: 'exhaustive',  // Tutte le pagine
    5: 'complete'     // Crawling completo
  };

  console.log(`  🔍 Adaptive search strategy: ${queryAnalysis.strategy}`);

  // Seed aggiuntivo da sitemap.xml/robots.txt (best-effort). Lanciata SENZA
  // await: la root URL è già in coda e pronta per il fetch, quindi non ha
  // senso far attendere l'intero crawl fino a SITEMAP_TIMEOUT_MS (era
  // un'attesa seriale fissa prima ancora del primo fetch, su un budget
  // totale di soli 5-15s). `queue` è mutato per riferimento: quando la
  // promise si risolve (durante uno degli `await` del loop sottostante) i
  // candidati vengono accodati e il prossimo `queue.sort()` li considera;
  // se risolve dopo che il loop è già terminato, il push è innocuo (coda
  // non più letta). Solo candidati con punteggio > 0 vengono accodati, per
  // non gonfiare la coda con URL irrilevanti alla query.
  (async () => {
    try {
      const origin = new URL(rootUrl).origin;
      const sitemapUrls = await getSitemapUrls(origin);
      const scored = sitemapUrls
        .filter(u => isSameDomain(u, rootUrl))
        .map(u => ({ url: u, score: scoreLinkCandidate('', u, queryAnalysis.tokens) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      for (const s of scored) queue.push({ url: s.url, depth: 1, strategy: 'sitemap', score: s.score });
      console.log(`  🗺️  Sitemap: ${sitemapUrls.length} URL trovate, ${scored.length} candidate rilevanti accodate`);
    } catch (err) {
      console.log(`  ⚠️  Sitemap discovery skipped/failed: ${err.message}`);
    }
  })();

  while (queue.length > 0 && results.length < MAX_PAGES_PER_SITE && !foundEnough) {
    // Ordina per rilevanza decrescente: best-first invece di FIFO puro.
    queue.sort((a, b) => b.score - a.score);

    // Preleva un batch di CONCURRENCY url dalla coda
    const batch = [];
    while (queue.length > 0 && batch.length < CONCURRENCY) {
      const item = queue.shift();
      if (!item || visited.has(item.url)) continue;
      // Salta risorse binarie o non-HTML
      if (item.url.match(/\.(jpg|jpeg|png|gif|pdf|docx|xlsx|zip|ico|css|js|woff|woff2|ttf|svg|mp4|mp3|webp)(\?.*)?$/i)) continue;
      visited.add(item.url);
      batch.push(item);
    }
    if (batch.length === 0) break;

    // Se il budget di tempo è già esaurito, non avviare un nuovo batch di fetch:
    // un timeout calcolato <= 0 passato ad axios è pericoloso (0 = nessun timeout,
    // negativo = eccezione non gestita negli internals dei socket di Node/follow-redirects
    // — verificato: entrambi i casi possono bloccare la richiesta indefinitamente).
    if (maxTime - (Date.now() - startTime) <= 0) {
      console.log(`  ⏱️  Time budget esaurito, salto il fetch del batch (${batch.length} URL scartati)`);
      break;
    }

    // Fetch parallelo (fetch+retry+cache condivisi con prefetchRootPages, vedi fetchAndCachePage)
    const fetched = await Promise.allSettled(
      batch.map(async ({ url, depth, strategy }) => {
        try {
          // Floor a 1000ms come rete di sicurezza: mai passare ad axios un
          // timeout <= 0 (un timeout <=0 è pericoloso: 0 = nessun timeout,
          // negativo = eccezione non gestita negli internals dei socket di
          // Node/follow-redirects — verificato: entrambi i casi possono
          // bloccare la richiesta indefinitamente).
          const timeoutMs = Math.max(1000, Math.min(PAGE_TIMEOUT_MS, maxTime - (Date.now() - startTime)));
          const pageData = await fetchAndCachePage(url, timeoutMs);
          if (!pageData) return null;
          return { pageData, url, depth, strategy };
        } catch (err) {
          console.log(`  ⚠️  Fetch failed [${url}]: ${err.message}`);
          return null;
        }
      })
    );

    for (const result of fetched) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { pageData, url, depth, strategy } = result.value;
      if (!pageData) continue;

      results.push(pageData);
      console.log(`  ✅ ${strategy} [depth=${depth}]: ${url} | "${pageData.title.substring(0,50)}" | ${pageData.rawText.length} chars`);

      // ─────────────────────────────────────────────────────────────────────────
      // 📌 CONSOLE.LOG: Links/URLs trovati durante il crawling
      // ─────────────────────────────────────────────────────────────────────────
      if (pageData.namedLinks && pageData.namedLinks.length > 0) {
        console.log(`🕸️ link trovati da crawling - Page: ${url}`);
        console.log(`   Found ${pageData.namedLinks.length} named links:`);
        pageData.namedLinks.forEach((link, idx) => {
          console.log(`       ${idx + 1}. [${link.text}] -> ${link.url}`);
        });
      }
      if (pageData.links && pageData.links.length > 0) {
        console.log(`   Found ${pageData.links.length} raw links (total internal links)`);
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Early stopping basato sulla RILEVANZA della pagina alla query, non sulla
      // sua lunghezza: fermarsi sulla prima pagina "lunga" (spesso la home page
      // piena di boilerplate) faceva perdere pagine pertinenti più in profondità.
      //
      // Tre livelli, per non sacrificare completezza/qualità in cambio di velocità:
      //   - domande semplici (isSimpleQuestion): si ferma alla PRIMA pagina che
      //     supera la soglia — comportamento originale, invariato.
      //   - domande non semplici ma non "comprehensive" (strategy 'targeted' o
      //     'adaptive', la maggioranza delle domande reali con un minimo di
      //     specificità): si ferma solo dopo EARLY_STOP_CONVERGING_HITS pagine
      //     che superano la soglia — evidenza convergente da più pagine, non
      //     una singola corrispondenza. NOTA: le pagine "categoria" (es. una
      //     panoramica generica "Anagrafe e stato civile") spesso superano
      //     comunque la soglia di rilevanza pur non contenendo i dettagli
      //     specifici (telefono/orari), che vivono tipicamente in una pagina
      //     FIGLIA più specifica (es. "/uffici/anagrafe"). Per questo, appena
      //     la soglia scatta NON ci si ferma di colpo: si accodano comunque i
      //     link figli di tutte le pagine di questa batch (sotto, invariato)
      //     e si concede UNA batch extra (graceBatchesLeft) prima di fermarsi
      //     davvero, dando ai figli appena scoperti — spesso i più specifici —
      //     una reale possibilità di essere fetchati.
      //   - strategy 'comprehensive' (query più complesse, complexity 3):
      //     nessun early-stop, crawling esaustivo fino a budget come da
      //     comportamento originale — qui la priorità resta la copertura.
      const relevance = scorePageRelevance(pageData, queryAnalysis.tokens);
      const qualifies = relevance >= RELEVANCE_EARLY_STOP_SCORE && pageData.rawText.length > MIN_CONTENT_CHARS;

      if (qualifies && queryAnalysis.isSimpleQuestion) {
        foundEnough = true;
        console.log(`  🎯 Early stopping: relevance score ${relevance} (threshold ${RELEVANCE_EARLY_STOP_SCORE})`);
        break;
      }

      if (qualifies && !queryAnalysis.isSimpleQuestion && queryAnalysis.strategy !== 'comprehensive') {
        relevantHits++;
        if (relevantHits >= EARLY_STOP_CONVERGING_HITS && graceBatchesLeft === null) {
          graceBatchesLeft = EARLY_STOP_GRACE_BATCHES;
          console.log(`  🎯 Soglia early-stop raggiunta (${relevantHits} pagine pertinenti convergenti, ultimo score ${relevance}): concesse ${EARLY_STOP_GRACE_BATCHES} batch extra prima di fermarsi davvero, per dare modo alle pagine figlie più specifiche (bonus di priorità in coda) di essere fetchate`);
        }
      }

      // Accoda i link figli se non abbiamo raggiunto MAX_DEPTH e la strategia lo permette,
      // scorando ciascun link per rilevanza (anchor-text + slug URL) rispetto alla query
      // così la coda a priorità visita prima i candidati più promettenti.
      if (depth < MAX_DEPTH && !foundEnough) {
        const nextStrategy = strategies[depth + 1] || 'expanded';
        const anchorTextByUrl = new Map((pageData.namedLinks || []).map(l => [l.url, l.text]));
        // Bonus di punteggio per i figli di una pagina già confermata pertinente
        // (qualifies): sono i candidati più probabili a contenere il dettaglio
        // specifico (es. telefono/orari del singolo ufficio, spesso su una
        // pagina figlia della panoramica generica che ha fatto scattare
        // "qualifies"). Serve soprattutto a dare loro precedenza reale nella
        // eventuale batch extra dell'early-stop a evidenza convergente — senza
        // bonus, competerebbero alla pari con link di navigazione generici già
        // in coda e rischierebbero di non essere mai fetchati prima di fermarsi.
        const childScoreBonus = qualifies ? 50 : 0;
        // NOTA: pageData.links è un array di URL nudi (stringhe), non di oggetti
        // {url} — vedi extractPageData ("Restituisci solo l'URL nudo"). Un bug
        // preesistente qui usava `link.url` su queste stringhe (sempre undefined),
        // per cui NESSUN link figlio veniva mai accodato: il crawl si fermava
        // sempre alla sola pagina root, a prescindere da MAX_DEPTH.
        for (const linkUrl of pageData.links) {
          if (!visited.has(linkUrl) && isSameDomain(linkUrl, rootUrl)) {
            const anchorText = anchorTextByUrl.get(linkUrl) || '';
            const score = scoreLinkCandidate(anchorText, linkUrl, queryAnalysis.tokens) + childScoreBonus;
            queue.push({ url: linkUrl, depth: depth + 1, strategy: nextStrategy, score });
          }
        }
      }
    }

    // Se la soglia di early-stop "a evidenza convergente" è stata raggiunta in
    // questa batch, i suoi link figli sono già stati accodati sopra: concedi
    // esattamente una batch extra per fetchare i candidati più promettenti
    // (spesso le pagine più specifiche) prima di fermarsi davvero.
    if (graceBatchesLeft !== null) {
      if (graceBatchesLeft <= 0) {
        foundEnough = true;
        console.log(`  🏁 Batch extra completata: mi fermo (evidenza convergente + pagine figlie già esplorate)`);
      } else {
        graceBatchesLeft--;
      }
    }

    // Controllo timeout globale
    if (Date.now() - startTime > maxTime) {
      console.log(`  ⏱️  Global timeout reached: ${maxTime}ms`);
      break;
    }
  }

  console.log(`  🏁 Adaptive search complete: ${results.length} pages from ${rootUrl}`);
  return results;
}

// ─── FASE 2: Firecrawl ricerca mirata ─────────────────────────────────────────

/**
 * Ricerca supplementare via Firecrawl — sostituisce SerpAPI (righe di storia
 * git precedenti), che nei test si è dimostrata inaffidabile: entrambe le
 * query andavano spesso in timeout senza restituire nulla di utile.
 *
 * Una sola chiamata invece delle due query SerpAPI (site:dominio + "dominio"
 * query): `includeDomains` sostituisce strutturalmente il trucco `site:`,
 * stesso effetto di scoping con una chiamata sola invece di due (meno costo,
 * meno latenza). `scrapeOptions.formats:['markdown']` fa sì che Firecrawl
 * scrapi anche le pagine trovate nella stessa chiamata: risultati arricchiti
 * con contenuto reale, non solo uno snippet — utile soprattutto quando FASE 1
 * (il crawler custom, a budget di tempo limitato) non riesce a raggiungere la
 * pagina più specifica, ma Firecrawl la trova comunque via ricerca diretta.
 *
 * Timeout NON allineato a PAGE_TIMEOUT_MS (8s, pensato per il fetch di una
 * singola pagina): una ricerca che scrapa fino a `limit` pagine richiede più
 * tempo di un fetch singolo o di uno snippet Google — verificato empiricamente
 * (~7s per 3 risultati arricchiti). Allineato invece al budget pieno della
 * query (`maxTime`), con floor più alto.
 *
 * Nessun retry: a differenza del retry economico usato per i singoli fetch di
 * pagina, ritentare qui raddoppierebbe il costo di una chiamata che scrapa
 * più pagine. Un solo tentativo; se fallisce, FASE 1 resta comunque la fonte
 * primaria della risposta (stesso comportamento di graceful-degradation già
 * in uso per SerpAPI).
 */
async function firecrawlSearch(query, siteHostname, maxTime = PAGE_TIMEOUT_MS) {
  if (!process.env.FIRECRAWL_API_KEY) {
    console.log('  ⏩ Firecrawl not configured, skipping');
    return [];
  }

  const timeout = Math.max(5000, Math.min(15000, maxTime));
  const limit = 5;

  console.log(`  🔍 Firecrawl search: "${query}" (dominio: ${siteHostname})`);
  try {
    const response = await firecrawl.search(query, {
      limit,
      includeDomains: [siteHostname],
      scrapeOptions: { formats: ['markdown'] },
      timeout
    });

    const results = (response.web || []).map(item => ({
      title:    item.title       || '',
      snippet:  item.description || '',
      url:      item.url         || '',
      markdown: item.markdown    || ''
    }));
    console.log(`  ✅ Firecrawl: ${results.length} risultati`);
    return results;
  } catch (err) {
    console.log(`  ⚠️  Firecrawl error: ${err.message}`);
    return [];
  }
}

// ─── Relevance scoring: trova le pagine più pertinenti alla query ─────────────

function scorePageRelevance(page, queryTokens) {
  const text = [page.title, page.metaDesc, page.headings.join(' '), page.rawText]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    const count = (text.split(token).length - 1);
    score += count;
    // Bonus se il token è nel titolo o headings
    if (page.title.toLowerCase().includes(token)) score += 5;
    if (page.headings.join(' ').toLowerCase().includes(token)) score += 3;
  }
  return score;
}

function tokenize(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\sàèéìíîòóùú]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// ─── Scoring di un link candidato PRIMA del fetch (guida la coda a priorità) ──

// Pagine "di supporto" quasi sempre utili in una demo, a prescindere dai
// token della specifica domanda: telefono/orari/indirizzo di solito vivono
// proprio qui, spesso su una pagina figlia più specifica di quella che
// nomina esplicitamente l'argomento cercato (es. la query menziona "carta
// d'identità" ma l'orario vive sulla pagina "contatti" dell'ufficio, non su
// quella del singolo servizio). Bonus fisso indipendente dai queryTokens.
const SUPPORT_PAGE_PATTERNS = ['contatt', 'orari', 'orario', 'chi siamo', 'chi-siamo', 'dove siamo', 'dove-siamo'];

function scoreLinkCandidate(linkText, url, queryTokens) {
  if (!queryTokens || queryTokens.length === 0) return 0;
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { /* url già normalizzato altrove */ }
  const slug = path.replace(/[\/\-_]+/g, ' ');
  const text = (linkText || '').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += 4;   // anchor text è il segnale più forte
    if (slug.includes(token)) score += 3;   // slug URL (es. /uffici/anagrafe/orari)
  }
  if (SUPPORT_PAGE_PATTERNS.some(p => slug.includes(p) || text.includes(p))) score += 5;
  return score;
}

// ─── Discovery sitemap.xml/robots.txt (best-effort, seed iniziale per la coda) ─

async function discoverSitemapUrls(origin) {
  const candidates = [`${origin}/sitemap.xml`];
  try {
    const robots = await httpClient.get(`${origin}/robots.txt`, { timeout: SITEMAP_TIMEOUT_MS, validateStatus: s => s === 200 });
    const matches = String(robots.data).match(/^Sitemap:\s*(\S+)/gim) || [];
    for (const line of matches) {
      const url = line.replace(/^Sitemap:\s*/i, '').trim();
      if (url && !candidates.includes(url)) candidates.push(url);
    }
  } catch { /* robots.txt assente/non raggiungibile: non blocca la ricerca sitemap */ }

  for (const sitemapUrl of candidates) {
    try {
      const resp = await httpClient.get(sitemapUrl, {
        timeout: SITEMAP_TIMEOUT_MS,
        validateStatus: s => s === 200,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0)' }
      });
      const contentType = (resp.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('xml') && !String(resp.data).trim().startsWith('<')) continue;

      const $ = cheerio.load(resp.data, { xmlMode: true });
      const urls = new Set();

      // sitemap-index: segui fino a 2 sitemap figlie (budget più stretto di site-analyzer.js)
      const childSitemaps = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
      if (childSitemaps.length > 0) {
        for (const childUrl of childSitemaps.slice(0, 2)) {
          try {
            const childResp = await httpClient.get(childUrl, { timeout: SITEMAP_TIMEOUT_MS, validateStatus: s => s === 200 });
            const $$ = cheerio.load(childResp.data, { xmlMode: true });
            $$('urlset > url > loc').each((_, el) => {
              const u = normalizeUrl(origin, $$(el).text().trim());
              if (u) urls.add(u);
            });
          } catch { /* sitemap figlia non raggiungibile: ignora, prosegui con le altre */ }
        }
      } else {
        $('urlset > url > loc').each((_, el) => {
          const u = normalizeUrl(origin, $(el).text().trim());
          if (u) urls.add(u);
        });
      }

      if (urls.size > 0) return [...urls];
    } catch { /* candidato non valido/non raggiungibile: prova il prossimo */ }
  }

  return [];
}

// discoverSitemapUrls() è query-indipendente (dipende solo dall'origin): senza
// cache, ogni singola domanda dell'utente sullo stesso sito rifà da capo
// robots.txt + sitemap.xml (+ fino a 2 sitemap figlie), anche a distanza di
// pochi secondi nella stessa conversazione. Cache per origin con lo stesso
// TTL del pageCache (15 min) — su cache hit i candidati sono disponibili
// subito, senza aspettare la rete, cosa che aiuta soprattutto ora che la
// discovery gira in background (vedi adaptiveSearch): rende disponibili
// candidati di qualità PRIMA che il crawl esaurisca la coda iniziale.
async function getSitemapUrls(origin) {
  const cached = cacheGet(sitemapCache, origin);
  if (cached) return cached;
  const urls = await discoverSitemapUrls(origin);
  cacheSet(sitemapCache, origin, urls);
  return urls;
}

// ─── Costruisce il contesto testuale da passare all'AI ────────────────────────

function buildContext(crawledPages, searchResults, query, configuredUrls) {
  const tokens = tokenize(query);

  // Ordina le pagine per rilevanza
  const scored = crawledPages
    .map(p => ({ ...p, score: scorePageRelevance(p, tokens) }))
    .sort((a, b) => b.score - a.score);

  const lines = [];

  // Inserisci prima le pagine più rilevanti
  let charCount = 0;
  for (const page of scored) {
    if (charCount >= MAX_CONTEXT_CHARS) break;
    const block = [
      `### Pagina: ${page.title || page.pageUrl}`,
      `URL: ${page.pageUrl}`,
      page.metaDesc ? `Descrizione: ${page.metaDesc}` : '',
      page.headings.length > 0 ? `Sezioni: ${page.headings.slice(0,8).join(' | ')}` : '',
      page.phones.length > 0  ? `Telefoni: ${page.phones.join(', ')}` : '',
      page.emails.length > 0  ? `Email: ${page.emails.join(', ')}` : '',
      page.addresses.length > 0 ? `Indirizzi: ${page.addresses.join('; ')}` : '',
      page.openingHours && page.openingHours.length > 0 ? `Orari: ${page.openingHours.join(' | ')}` : '',
      `Contenuto:\n${page.rawText.substring(0, 1200)}`,
      ''
    ].filter(Boolean).join('\n');

    lines.push(block);
    charCount += block.length;
  }

  // Aggiungi risultati Firecrawl — a differenza dei vecchi risultati SERPApi
  // (solo snippet), questi includono anche il markdown scrapato da Firecrawl
  // nella stessa chiamata (vedi firecrawlSearch), quindi possono portare
  // contenuto reale anche per pagine che il crawler di FASE 1 non ha
  // raggiunto. Nessun tetto di caratteri qui (richiesto esplicitamente): il
  // markdown va incluso per intero, non solo un estratto.
  //
  // Il markdown di Firecrawl inizia quasi sempre con i link di accessibilità
  // "Vai al contenuto/Vai alla navigazione/Vai al footer/Salta al contenuto"
  // (skip-link dei siti istituzionali) — puro rumore, li rimuoviamo comunque.
  const stripSkipLinks = (md) => md
    .replace(/\[(?:Vai al contenuto|Vai alla navigazione|Vai al footer|Salta al contenuto)\]\([^)]*\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (searchResults.length > 0) {
    lines.push('\n### Risultati di ricerca (Firecrawl):');
    for (const r of searchResults.slice(0, 6)) {
      lines.push(`- [${r.title}](${r.url})\n  ${r.snippet}`);
      if (r.markdown) {
        lines.push(`  Contenuto:\n  ${stripSkipLinks(r.markdown).replace(/\n/g, '\n  ')}`);
      }
    }
  }

  // Aggiungi lista URL crawlati (utile per l'AI per citare link reali)
  if (crawledPages.length > 0) {
    lines.push('\n### Tutte le pagine indicizzate del sito:');
    for (const p of crawledPages.slice(0, 40)) {
      lines.push(`- ${p.pageUrl} → "${p.title}"`);
    }
  }

  // Aggiungi link con testo (per output utile all'utente)
  if (crawledPages.length > 0) {
    lines.push('\n### Link utili trovati sul sito:');
    for (const p of crawledPages.slice(0, 10)) {
      if (p.namedLinks && p.namedLinks.length > 0) {
        for (const link of p.namedLinks.slice(0, 3)) {
          const cleanedUrl = cleanUrlForContext(link.url);
          if (cleanedUrl) {
            lines.push(`- [${link.text}](${cleanedUrl})`);
          }
        }
      }
    }
  }
  return lines.join('\n');
}

// ─── ENTRY POINT PRINCIPALE ───────────────────────────────────────────────────

/**
 * searchConfiguredSites(query, configuredUrls, product)
 *
 * @param {string}   query          - Domanda dell'utente
 * @param {string[]} configuredUrls - URL configurati nel config HTML
 * @param {string}   product        - 'comunicai' | 'medicai'
 * @returns {Promise<string>}       - Contesto strutturato grezzo (titoli, headings,
 *                                    telefoni, email, indirizzi, snippet, link) —
 *                                    NON una risposta finale: la sintesi con AI
 *                                    (persona/istruzioni/lingua) avviene a valle,
 *                                    una sola volta, nell'orchestrator.
 */
async function searchConfiguredSites(query, configuredUrls, product = 'comunicai') {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔎 DEEP SEARCH ENGINE — query: "${query}"`);
  console.log(`📌 URLs: ${configuredUrls.join(' | ')}`);
  console.log(`📦 Product: ${product}`);
  console.log(`${'═'.repeat(60)}`);

  if (!configuredUrls || configuredUrls.length === 0) {
    return `Nessun sito configurato. Contatta l'amministratore del sistema.`;
  }

  // ── FASE 0: Analisi query e stima tempo ─────────────────────────────────────
  console.log(`\n[FASE 0] Query analysis and time estimation...`);
  const queryAnalysis = await analyzeQuery(query);
  console.log(`  📊 Query complexity: ${queryAnalysis.complexity}/3`);
  console.log(`  🎯 Strategy: ${queryAnalysis.strategy}`);
  console.log(`  ⏱️  Estimated time: ${queryAnalysis.estimatedTime}ms`);

  // ── FASE 1+2: Crawling adattivo e Firecrawl, in parallelo tra loro e per ogni
  // root URL configurato (erano due cicli for...await sequenziali, eseguiti
  // l'uno dopo l'altro: con demo a più searchUrls la latenza si sommava invece
  // di sovrapporsi) ─────────────────────────────────────────────────────────
  console.log(`\n[FASE 1+2] Adaptive search + Firecrawl in parallelo su ${configuredUrls.length} root URL...`);

  const [crawlSettled, searchSettled] = await Promise.all([
    Promise.allSettled(configuredUrls.map(rootUrl => adaptiveSearch(rootUrl, queryAnalysis, queryAnalysis.estimatedTime))),
    Promise.allSettled(configuredUrls.map(rootUrl => firecrawlSearch(query, getHostname(rootUrl), queryAnalysis.estimatedTime)))
  ]);

  const allCrawledPages = [];
  crawlSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') allCrawledPages.push(...r.value);
    else console.error(`  ❌ Adaptive search failed for ${configuredUrls[i]}: ${r.reason.message}`);
  });
  console.log(`[FASE 1 RISULTATO] ${allCrawledPages.length} pagine trovate`);

  const allSearchResults = [];
  searchSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') allSearchResults.push(...r.value);
    else console.error(`  ❌ Firecrawl search failed for ${configuredUrls[i]}: ${r.reason.message}`);
  });
  console.log(`[FASE 2 RISULTATO] ${allSearchResults.length} risultati Firecrawl`);

  // ── FASE 3: Costruisci contesto ──────────────────────────────────────────────
  console.log(`\n[FASE 3] Building context...`);

  let context = '';

  if (allCrawledPages.length === 0 && allSearchResults.length === 0) {
    // Nessun dato trovato — usa solo conoscenza AI con link al sito
    console.log(`  ⚠️  No data crawled, using AI general knowledge only`);
    context = `Il sito ${configuredUrls.join(', ')} non era accessibile al momento della ricerca.`;
  } else {
    context = buildContext(allCrawledPages, allSearchResults, query, configuredUrls);
  }

  console.log(`  📄 Context size: ${context.length} chars`);

  // ─────────────────────────────────────────────────────────────────────────
  // 📌 CONSOLE.LOG: Links/URLs inviati a OpenAI (prima della chiamata)
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n🔗 link nel contesto restituito al tool-executor`);
  console.log(`   Query: "${query}"`);
  console.log(`   Context length: ${context.length} chars`);

  // Estrai tutti gli URL presenti nel contesto per log
  const urlMatches = context.match(/https?:\/\/[^\s\)\]"']+/g) || [];
  const uniqueUrls = [...new Set(urlMatches)];
  console.log(`   Total unique URLs in context: ${uniqueUrls.length}`);
  if (uniqueUrls.length > 0) {
    console.log(`   URLs disponibili per la sintesi finale:`);
    uniqueUrls.slice(0, 20).forEach((url, idx) => {
      console.log(`     ${idx + 1}. ${url}`);
    });
    if (uniqueUrls.length > 20) {
      console.log(`     ... and ${uniqueUrls.length - 20} more URLs`);
    }
  }
  console.log(`🔗 fine link nel contesto\n`);
  // ─────────────────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ DEEP SEARCH COMPLETE in ${elapsed}s`);
  console.log(`${'═'.repeat(60)}\n`);

  return context;
}

/**
 * prefetchRootPages(urls)
 *
 * Prefetch speculativo delle root URL configurate su una demo — pensato per
 * essere lanciato SENZA await, in parallelo alla prima chiamata OpenAI che
 * decide se il turno richiede search_configured_sites (vedi orchestrator.js).
 * Per la stragrande maggioranza dei messaggi su una demo con searchUrls
 * configurati il tool viene comunque chiamato: oggi il flusso è strettamente
 * sequenziale ("prima decide, poi cerca"), e il primissimo fetch dentro
 * adaptiveSearch è quasi sempre proprio la root URL. Anticiparlo qui elimina
 * quella sequenzialità nel caso comune — usa lo stesso pageCache condiviso,
 * quindi se il crawl vero parte la trova già in cache e la salta.
 *
 * Best-effort per design: un fallimento su un singolo URL non deve mai
 * propagarsi al chiamante (la richiesta di chat non deve fallire per un
 * prefetch speculativo) — se il prefetch fallisce, il crawl vero riproverà
 * comunque da capo quando (e se) parte.
 *
 * @param {string[]} urls - demo.searchUrls
 */
async function prefetchRootPages(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const startTime = Date.now();
  const results = await Promise.allSettled(urls.map(async (rootUrl) => {
    try {
      const url = normalizeUrl(rootUrl, rootUrl) || rootUrl;
      await fetchAndCachePage(url, PAGE_TIMEOUT_MS);
      return true;
    } catch (err) {
      console.log(`  ⚠️  Prefetch speculativo fallito [${rootUrl}]: ${err.message}`);
      return false;
    }
  }));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`  🚀 Prefetch speculativo: ${ok}/${urls.length} root URL pronte in cache in ${Date.now() - startTime}ms`);
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = { searchConfiguredSites, prefetchRootPages };
