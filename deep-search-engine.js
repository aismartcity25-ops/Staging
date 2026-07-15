/**
 * ============================================================
 * DEEP SEARCH ENGINE — v2.0
 * Motore di ricerca completo con crawling ricorsivo, scraping
 * HTML, SERPApi mirato, e fallback AI sempre attivo.
 *
 * Compatibile con ComunicAI e MedicAI.
 * Usa solo: axios, cheerio (già installati nel progetto).
 * ============================================================
 *
 * ARCHITETTURA:
 *
 *  searchConfiguredSites(query, urls, product)
 *       │
 *       ├─ FASE 1: Deep Crawler
 *       │    Fa il fetch dell'URL root configurato,
 *       │    estrae tutti i link interni (stesso dominio),
 *       │    poi visita ogni sotto-pagina ricorsivamente
 *       │    fino a MAX_DEPTH livelli.
 *       │    Da ogni pagina estrae: testo, link, telefoni,
 *       │    email, indirizzi, titoli h1/h2/h3, meta.
 *       │    Tutto finisce in un indice testuale piatto.
 *       │
 *       ├─ FASE 2: SERPApi (se configurata)
 *       │    Query site:dominio.it + user query
 *       │    Restituisce snippet + URL da Google
 *       │
 *       ├─ FASE 3: AI Synthesis
 *       │    Passa tutto il testo raccolto come contesto
 *       │    a GPT-4o-mini che formula la risposta finale.
 *       │    Se il testo è > 12000 chars lo scorcia in modo
 *       │    intelligente per non superare il context window.
 *       │
 *       └─ GARANTITO: non restituisce mai una risposta vuota.
 *                     Se tutto fallisce, AI risponde con
 *                     conoscenza generale + link al sito.
 */

'use strict';

const axios  = require('axios');
const cheerio = require('cheerio');

// ─── Costanti configurabili ───────────────────────────────────────────────────

const MAX_PAGES_PER_SITE   = 60;   // Massimo pagine da visitare per sito
const MAX_DEPTH            = 5;    // Profondità massima crawling (root=0, figlio=1, nipote=2, bis=3, tris=4, quad=5)
const PAGE_TIMEOUT_MS      = 8000; // Timeout per ogni fetch
const CONCURRENCY          = 4;    // Richieste HTTP parallele
const MAX_CONTEXT_CHARS    = 14000; // Massimo caratteri di contesto da passare all'AI
const CACHE_TTL_MS         = 15 * 60 * 1000; // Cache 15 minuti
const EARLY_STOP_CHARS     = 3000; // Caratteri minimi per fermarsi
const MAX_TOTAL_TIME_MS    = 30000; // Tempo massimo totale per la ricerca
const QUERY_TIMEOUT_MS     = 5000; // Timeout per analisi query

// ─── Cache in-memory ─────────────────────────────────────────────────────────

const pageCache   = new Map();  // url → { text, links, ts }
const crawlCache  = new Map();  // rootUrl → { pages: [...], ts }

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

  // Rimuovi elementi non utili
  $('script, style, noscript, iframe, svg, img, video, audio, nav, footer, .cookie-banner, #cookie, .popup').remove();

  // Titolo pagina
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';

  // Meta description
  const metaDesc = $('meta[name="description"]').attr('content') || '';

  // Estrai tutti i testi dalle sezioni principali
  const textParts = [];
  $('main, article, section, .content, #content, .main-content, [role="main"], body').each((_, el) => {
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

// Estrai link interni (per il crawler)
const links = [];
$('a[href]').each((_, el) => {
  const href = $(el).attr('href');
  const resolved = normalizeUrl(pageUrl, href);
  if (resolved && isSameDomain(resolved, pageUrl)) {
    links.push(resolved); // Restituisci solo l'URL nudo
  }
});

  // Estrai contatti
  const fullText = rawText + ' ' + $('body').text();

  const phones = [...new Set(
    (fullText.match(/(?:\+39[\s.-]?)?(?:0\d{1,4}[\s.-]?\d{5,8}|3\d{2}[\s.-]?\d{6,7}|800[\s.-]?\d{5,6})/g) || [])
      .map(p => p.replace(/\s+/g, '').trim())
      .filter(p => p.replace(/\D/g,'').length >= 9)
  )].slice(0, 10);

  const emails = [...new Set(
    (fullText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
  )].slice(0, 10);

  const addresses = [...new Set(
    (fullText.match(/(?:Via|Piazza|Corso|Viale|Strada|Largo|Vicolo)\s+[A-Za-zÀ-ú\s']+\s*,?\s*\d+[a-zA-Z]?,?\s*\d{5}/gi) || [])
      .map(a => a.trim())
  )].slice(0, 5);

// Link con testo (per output utile all'utente)
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
  return { title, metaDesc, rawText, headings, links, namedLinks, phones, emails, addresses, pageUrl };
}

// ─── FASE 1: Ricerca Adattiva ─────────────────────────────────────────────────

/**
 * Ricerca adattiva che inizia con strategia mirata e aumenta la depth solo se necessario.
 * Restituisce un array di oggetti { title, rawText, headings, phones, emails, addresses, pageUrl }
 */
async function adaptiveSearch(rootUrl, queryAnalysis, maxTime = MAX_TOTAL_TIME_MS) {
  const startTime = Date.now();
  const visited = new Set();
  const queue = [{ url: normalizeUrl(rootUrl, rootUrl) || rootUrl, depth: 0, strategy: 'targeted' }];
  const results = [];
  let currentDepth = 0;
  let foundEnough = false;

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

  while (queue.length > 0 && results.length < MAX_PAGES_PER_SITE && !foundEnough) {
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

    // Fetch parallelo
    const fetched = await Promise.allSettled(
      batch.map(async ({ url, depth, strategy }) => {
        // Controlla cache pagina
        const cachedPage = cacheGet(pageCache, url);
        if (cachedPage) return { pageData: cachedPage, url, depth, strategy };

        try {
          const resp = await axios.get(url, {
            timeout: Math.min(PAGE_TIMEOUT_MS, maxTime - (Date.now() - startTime)),
            maxRedirects: 5,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0; +https://assistant.local)',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
            },
            // Accetta solo HTML
            validateStatus: s => s >= 200 && s < 400
          });
          const contentType = (resp.headers['content-type'] || '').toLowerCase();
          if (!contentType.includes('html')) return null;

          const pageData = extractPageData(resp.data, url);
          cacheSet(pageCache, url, pageData);
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

      // Early stopping se abbiamo trovato informazioni sufficienti
      if (pageData.rawText.length > EARLY_STOP_CHARS && queryAnalysis.isSimpleQuestion) {
        foundEnough = true;
        console.log(`  🎯 Early stopping: found enough information (${pageData.rawText.length} chars)`);
        break;
      }

      // Accoda i link figli se non abbiamo raggiunto MAX_DEPTH e la strategia lo permette
      if (depth < MAX_DEPTH && !foundEnough) {
        const nextStrategy = strategies[depth + 1] || 'expanded';
        for (const link of pageData.links) {
          if (!visited.has(link.url) && isSameDomain(link.url, rootUrl)) {
            queue.push({ url: link.url, depth: depth + 1, strategy: nextStrategy });
          }
        }
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

// ─── FASE 2: SERPApi ricerca mirata ──────────────────────────────────────────

async function serpApiSearch(query, siteHostname) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    console.log('  ⏩ SERPApi not configured, skipping');
    return [];
  }

  const results = [];

  // Due query: site-specific e branded
  const queries = [
    `site:${siteHostname} ${query}`,
    `"${siteHostname}" ${query}`
  ];

  for (const q of queries) {
    try {
      console.log(`  🔍 SERPApi query: "${q}"`);
      const resp = await axios.get('https://serpapi.com/search', {
        params: {
          q,
          api_key:  apiKey,
          engine:   'google',
          hl:       'it',
          gl:       'it',
          num:      10,
          filter:   1
        },
        timeout: 10000
      });

      if (resp.data && resp.data.organic_results) {
        for (const r of resp.data.organic_results.slice(0, 8)) {
          results.push({
            title:   r.title   || '',
            snippet: r.snippet || '',
            url:     r.link    || ''
          });
        }
        console.log(`  ✅ SERPApi: ${resp.data.organic_results.length} results`);
      }
    } catch (err) {
      console.log(`  ⚠️  SERPApi error: ${err.message}`);
    }
  }

  return results;
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

// ─── Costruisce il contesto testuale da passare all'AI ────────────────────────

function buildContext(crawledPages, serpResults, query, configuredUrls) {
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
      `Contenuto:\n${page.rawText.substring(0, 1200)}`,
      ''
    ].filter(Boolean).join('\n');

    lines.push(block);
    charCount += block.length;
  }

  // Aggiungi risultati SERPApi
  if (serpResults.length > 0) {
    lines.push('\n### Risultati Google (SERPApi):');
    for (const r of serpResults.slice(0, 6)) {
      lines.push(`- [${r.title}](${r.url})\n  ${r.snippet}`);
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

// ─── FASE 3: AI Synthesis ─────────────────────────────────────────────────────

async function synthesizeWithAI(query, context, configuredUrls, product, openaiClient) {
  const siteList = configuredUrls.join(', ');

  const systemPrompt = `Sei un assistente esperto e sempre utile per il sito: ${siteList}
Hai a disposizione il contenuto COMPLETO di tutte le pagine del sito, estratto da un crawling in profondità.

REGOLE ASSOLUTE:
1. Usa ESCLUSIVAMENTE le informazioni presenti nel contesto qui sotto per rispondere.
2. Cita SEMPRE URL reali trovati nel contesto — mai inventarli.
3. Se l'informazione è presente nel contesto, forniscila in modo completo e diretto.
4. Se l'informazione NON è presente, dì all'utente cosa hai trovato di più vicino e indica il link principale del sito.
5. NON dire mai "non ho trovato" senza prima dare alternative utili.
6. Rispondi in italiano, in modo chiaro, strutturato con elenchi puntati dove appropriato.
7. Includi sempre: link diretti, numeri di telefono, email, orari — se presenti nel contesto.

PRODOTTO: ${product === 'medicai' ? 'Assistente sanitario (MedicAI)' : 'Assistente comunale/PA (ComunicAI)'}

--- CONTESTO ESTRATTO DAL SITO ---
${context}
--- FINE CONTESTO ---`;

  try {
    const response = await openaiClient.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0.2,
      max_tokens:  1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: query }
      ]
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error(`  ❌ AI synthesis error: ${err.message}`);
    // Fallback minimale
    return `Non sono riuscito a elaborare la risposta in questo momento. Visita direttamente: ${configuredUrls[0]}`;
  }
}

// ─── ENTRY POINT PRINCIPALE ───────────────────────────────────────────────────

/**
 * searchConfiguredSites(query, configuredUrls, product, openaiClient)
 *
 * @param {string}   query          - Domanda dell'utente
 * @param {string[]} configuredUrls - URL configurati nel config HTML
 * @param {string}   product        - 'comunicai' | 'medicai'
 * @param {object}   openaiClient   - Istanza OpenAI già inizializzata
 * @returns {Promise<string>}       - Risposta testuale formattata
 */
async function searchConfiguredSites(query, configuredUrls, product = 'comunicai', openaiClient) {
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

  // ── FASE 1: Ricerca adattiva ────────────────────────────────────────────────
  console.log(`\n[FASE 1] Adaptive search...`);
  const allCrawledPages = [];

  for (const rootUrl of configuredUrls) {
    try {
      const pages = await adaptiveSearch(rootUrl, queryAnalysis, queryAnalysis.estimatedTime);
      allCrawledPages.push(...pages);
    } catch (err) {
      console.error(`  ❌ Adaptive search failed for ${rootUrl}: ${err.message}`);
    }
  }

  console.log(`\n[FASE 1 RISULTATO] ${allCrawledPages.length} pagine trovate`);

  // ── FASE 2: SERPApi mirato per ogni dominio ─────────────────────────────────
  console.log(`\n[FASE 2] SERPApi site-targeted search...`);
  const allSerpResults = [];

  for (const rootUrl of configuredUrls) {
    const hostname = getHostname(rootUrl);
    const serpResults = await serpApiSearch(query, hostname);
    allSerpResults.push(...serpResults);
  }

  console.log(`[FASE 2 RISULTATO] ${allSerpResults.length} risultati SERPApi`);

  // ── FASE 3: Costruisci contesto e sintetizza con AI ─────────────────────────
  console.log(`\n[FASE 3] Building context and AI synthesis...`);

  let context = '';

  if (allCrawledPages.length === 0 && allSerpResults.length === 0) {
    // Nessun dato trovato — usa solo conoscenza AI con link al sito
    console.log(`  ⚠️  No data crawled, using AI general knowledge only`);
    context = `Il sito ${configuredUrls.join(', ')} non era accessibile al momento della ricerca.`;
  } else {
    context = buildContext(allCrawledPages, allSerpResults, query, configuredUrls);
  }

  console.log(`  📄 Context size: ${context.length} chars`);

  // ─────────────────────────────────────────────────────────────────────────
  // 📌 CONSOLE.LOG: Links/URLs inviati a OpenAI (prima della chiamata)
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n🔗 link inviati dal backend ad openai dal buildcontext`);
  console.log(`   Query: "${query}"`);
  console.log(`   Context length: ${context.length} chars`);
  
  // Estrai tutti gli URL presenti nel contesto per log
  const urlMatches = context.match(/https?:\/\/[^\s\)\]"']+/g) || [];
  const uniqueUrls = [...new Set(urlMatches)];
  console.log(`   Total unique URLs in context: ${uniqueUrls.length}`);
  if (uniqueUrls.length > 0) {
    console.log(`   URLs being sent to OpenAI:`);
    uniqueUrls.slice(0, 20).forEach((url, idx) => {
      console.log(`     ${idx + 1}. ${url}`);
    });
    if (uniqueUrls.length > 20) {
      console.log(`     ... and ${uniqueUrls.length - 20} more URLs`);
    }
  }
  console.log(`🔗 fine link inviati dal backend ad openai dal buildcontext\n`);
  // ─────────────────────────────────────────────────────────────────────────

  const answer = await synthesizeWithAI(query, context, configuredUrls, product, openaiClient);

  // ─────────────────────────────────────────────────────────────────────────
  // 📌 CONSOLE.LOG: Risposta di OpenAI con i links/URLs
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n🤖 links ricevuto da openai`);
  console.log(`   Query: "${query}"`);
  console.log(`   Answer length: ${answer.length} chars`);
  
  // Estrai tutti gli URL presenti nella risposta
  const answerUrlMatches = answer.match(/https?:\/\/[^\s<\]")']+/g) || [];
  const uniqueAnswerUrls = [...new Set(answerUrlMatches)];
  console.log(`   URLs in OpenAI response: ${uniqueAnswerUrls.length}`);
  if (uniqueAnswerUrls.length > 0) {
    console.log(`   Links provided by OpenAI:`);
    uniqueAnswerUrls.forEach((url, idx) => {
      console.log(`     ${idx + 1}. ${url}`);
    });
  }
  console.log(`   Answer preview: ${answer.substring(0, 200)}...`);
  console.log(`🤖 fine links ricevuto da openai\n`);
  // ─────────────────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ DEEP SEARCH COMPLETE in ${elapsed}s`);
  console.log(`${'═'.repeat(60)}\n`);

  return answer;
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = { searchConfiguredSites };
