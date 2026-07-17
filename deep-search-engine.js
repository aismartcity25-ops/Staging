/**
 * ============================================================
 * DEEP SEARCH ENGINE — v2.1 (Optimized Hybrid Version)
 * Motore di ricerca mirato con SERPApi e fallback AI attivo.
 * Compatibile con ComunicAI e MedicAI.
 * ============================================================
 */

'use strict';
const dns = require('dns');
const http = require('http');
const https = require('https');
const axios  = require('axios');
const cheerio = require('cheerio');
const francModule = require('franc-min');
const franc = francModule.franc || francModule;

const LANGUAGE_MAP = {
  eng: 'en',
  ita: 'it',
  fra: 'fr',
  spa: 'es',
  deu: 'de',
  por: 'pt',
  nld: 'nl',
  rus: 'ru',
  jpn: 'ja',
  zho: 'zh',
  ara: 'ar',
  tur: 'tr',
  pol: 'pl',
  swe: 'sv',
  dan: 'da'
};

function detectLanguage(text) {
  const normalized = (text || '').trim();
  if (!normalized) return 'it';

  const code = franc(normalized, { minLength: 2 });
  if (code && code !== 'und') {
    return LANGUAGE_MAP[code] || 'it';
  }

  if (/[\u0600-\u06FF]/.test(normalized)) return 'ar';
  if (/[\u0400-\u04FF]/.test(normalized)) return 'ru';
  if (/[\u4E00-\u9FFF]/.test(normalized)) return 'zh';
  if (/[\u3040-\u30FF]/.test(normalized)) return 'ja';
  if (/[\u0E00-\u0E7F]/.test(normalized)) return 'th';
  if (/[\u0900-\u097F]/.test(normalized)) return 'hi';
  if (/[\u0A00-\u0A7F]/.test(normalized)) return 'pa';
  if (/[\u0B00-\u0B7F]/.test(normalized)) return 'bn';
  if (/[\u0C00-\u0C7F]/.test(normalized)) return 'te';
  if (/[\u0D00-\u0D7F]/.test(normalized)) return 'ml';

  return 'it';
}

async function translateQueryToItalian(query, fromLang, openaiClient) {
  if (!query || fromLang === 'it') return query;

  try {
    const prompt = `Translate this user query into Italian. Return only the translated query and no explanation. Original language: ${fromLang}\n\nQuery: ${query}`;
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.0,
      max_tokens: 150,
      messages: [
        { role: 'system', content: 'You are a translation assistant.' },
        { role: 'user', content: prompt }
      ]
    });

    const translated = response.choices?.[0]?.message?.content?.trim();
    return translated || query;
  } catch (err) {
    console.log(`  ⚠️ Query translation failed: ${err.message}`);
    return query;
  }
}

// ─── COSTANTI CONFIGURABILI (OTTIMIZZATE) ────────────────────────────────────

const PAGE_TIMEOUT_MS      = 10000;  // Timeout per il fetch di ogni singola pagina
const MAX_CONTEXT_CHARS    = 10000; // Massimo caratteri di contesto da passare all'AI
const CACHE_TTL_MS         = 60 * 60 * 1000; // Cache in-memory da 1 ora
const MAX_TOTAL_TIME_MS    = 15000; // Tempo massimo complessivo per l'operazione

// ─── CACHE IN-MEMORY ─────────────────────────────────────────────────────────

const pageCache   = new Map();  // url → { data, ts }

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { map.delete(key); return null; }
  return entry.data;
}

function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
}

const queryCache = new Map(); // query -> { data, ts }

function normalizeCacheKey(...parts) {
  return parts
    .filter(Boolean)
    .join('||')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getTimeRemaining(startTime) {
  return MAX_TOTAL_TIME_MS - (Date.now() - startTime);
}

function ensureTimeRemaining(startTime, stage = 'operation') {
  const remaining = getTimeRemaining(startTime);
  if (remaining <= 0) throw new Error(`Deadline exceeded before ${stage}`);
  return remaining;
}

function isSnippetSufficient(candidate, queryTokens, query = '') {
  const lowerQuery = query.toLowerCase();

  // Domande che richiedono un dato concreto (nome, ruolo, contatto, luogo, orario, prezzo...)
  // vanno sempre fetchate: lo snippet raramente contiene la risposta esatta.
  const needsDeepFetch = /\b(?:chi|nome|cognome|direttor|responsab|referent|contatt|telefono|email|indirizz|orari|orario|quando|dove|qual'è|qual e|quanto costa|prezzo|costo)\b/.test(lowerQuery);
  if (needsDeepFetch) return false;

  const text = `${candidate.title || ''} ${candidate.snippet || ''}`.toLowerCase();
  const hits = queryTokens.filter(t => text.includes(t)).length;
  const requiredHits = Math.max(1, Math.ceil(queryTokens.length * 0.6));
  return candidate.snippet && candidate.snippet.length > 120 && hits >= requiredHits;
}

// ─── ANALISI ADATTIVA DELLA QUERY ────────────────────────────────────────────

async function analyzeQuery(query) {
  const startTime = Date.now();
  const tokens = tokenize(query);
  const hasContactInfo = tokens.some(t => ['telefono', 'email', 'indirizzo', 'orari', 'orario'].includes(t));
  const hasServiceName = tokens.some(t => ['servizio', 'prenotazione', 'appuntamento', 'documenti'].includes(t));
  const hasSpecificInfo = tokens.some(t => ['costo', 'prezzo', 'validità', 'scadenza', 'requisiti'].includes(t));
  const isSimpleQuestion = query.length < 50;
  
  const complexityScore = (hasContactInfo ? 1 : 0) + (hasServiceName ? 1 : 0) + (hasSpecificInfo ? 1 : 0) + (isSimpleQuestion ? 0 : 1);
  const estimatedTime = Math.min(5000 + (complexityScore * 3000), 15000);
  const lang = detectLanguage(query);

  return {
    complexity: complexityScore,
    strategy: 'hybrid-targeted',
    hasContactInfo,
    hasServiceName,
    hasSpecificInfo,
    isSimpleQuestion,
    estimatedTime,
    tokens,
    lang,
    timeElapsed: Date.now() - startTime
  };
}

// ─── UTILITY DI NORMALIZZAZIONE E PULIZIA URL ────────────────────────────────

function normalizeUrl(base, href) {
  try {
    if (!href) return null;
    href = href.trim();
    href = href.replace(/\s+(target|rel|onclick|class|id|style|title|data-[^=\s]+)\s*=\s*["'][^"']*["']/gi, ' ').trim();
    
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
    const url = new URL(href, base);
    url.hash = ''; 
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function cleanUrlForContext(url) {
  if (!url) return null;
  let cleaned = url.replace(/\s+(target|rel|onclick|class|id|style|title|data-[^=\s]+)\s*=\s*["'][^"']*["']/gi, ' ').trim();
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

function isPdfUrl(url) {
  try {
    return /\.pdf(?:[?#]|$)/i.test(url);
  } catch {
    return false;
  }
}

function isPdfResponse(headers, buffer) {
  const contentType = (headers['content-type'] || '').toLowerCase();
  if (contentType.includes('pdf')) return true;
  if (!buffer || buffer.length < 4) return false;
  return buffer.slice(0, 4).toString('utf8') === '%PDF';
}

function tokenize(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\sàèéìíîòóùú]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// ─── ESTRAZIONE DATI PAGINA (SCRAPING HTML) ──────────────────────────────────

function extractPageData(html, pageUrl) {
  const $ = cheerio.load(html);

  // Rimuove elementi rumorosi o non testuali
  $('script, style, noscript, iframe, svg, img, video, audio, nav, footer, .cookie-banner, #cookie, .popup').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';
  const metaDesc = $('meta[name="description"]').attr('content') || '';

  const textParts = [];
  $('main, article, section, .content, #content, .main-content, [role="main"], body').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 50) textParts.push(t);
  });

  if (textParts.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    if (bodyText) textParts.push(bodyText);
  }

  const rawText = textParts.join(' ').substring(0, 4000); 

  const headings = [];
  $('h1, h2, h3').each((i, el) => {
    if (i > 15) return;
    const t = $(el).text().trim();
    if (t.length > 3) headings.push(t);
  });

  const fullText = rawText + ' ' + $('header, main, .contact, .contatti').text();

  const phones = [...new Set(
    (fullText.match(/(?:\+39[\s.-]?)?(?:0\d{1,4}[\s.-]?\d{5,8}|3\d{2}[\s.-]?\d{6,7}|800[\s.-]?\d{5,6})/g) || [])
      .map(p => p.replace(/\s+/g, '').trim())
      .filter(p => p.replace(/\D/g,'').length >= 9)
  )].slice(0, 5);

  const emails = [...new Set(
    (fullText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [])
  )].slice(0, 5);

  const addresses = [...new Set(
    (fullText.match(/(?:Via|Piazza|Corso|Viale|Strada|Largo|Vicolo)\s+[A-Za-zÀ-ú\s']+\s*,?\s*\d+[a-zA-Z]?,?\s*\d{5}/gi) || [])
      .map(a => a.trim())
  )].slice(0, 3);

  const namedLinks = [];
  $('a[href]').each((i, el) => {
    if (i > 30) return;
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const resolved = normalizeUrl(pageUrl, href);
    if (resolved && text.length > 3 && !resolved.match(/\.(jpg|jpeg|png|gif|pdf|ico|css|js|woff)/i)) {
      namedLinks.push({ text, url: resolved });
    }
  });

  return { title, metaDesc, rawText, headings, namedLinks, phones, emails, addresses, pageUrl };
}

// ─── FASE 1: RICERCA MIRATA CON SERPAPI ──────────────────────────────────────
dns.setDefaultResultOrder('ipv4first');

// 2. Crea un'istanza Axios riutilizzabile con Keep-Alive attivo
const serpApiClient = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 3000 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 3000 }),
});

async function serpApiSearch(query, siteHostname, lang = 'it', signal = null) {
  const cacheKey = normalizeCacheKey('serpapi', siteHostname, lang, query);
  const cached = cacheGet(queryCache, cacheKey);
  if (cached) {
    console.log(`  ⚡ SERPApi cache hit for query="${query}" on site=${siteHostname}`);
    return cached;
  }

  console.log(`  🔍 SERPApi search for query="${query}" on site=${siteHostname} lang=${lang}`);
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️ SERPApi API key missing! Hybrid search requires SERPApi.');
    return [];
  } else {
    console.log('  ✅ SERPApi API key found, proceeding with search.');
  }

  const results = [];
  const queries = [
    `site:${siteHostname} ${query}`,
  ];

  for (const q of queries) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`  🔍 SERPApi query (attempt ${attempt}/${maxAttempts}): "${q}"`);

        // Usa l'istanza ottimizzata 'serpApiClient' invece di 'axios' generico
        const resp = await serpApiClient.get('https://serpapi.com/search', {
          params: {
            q,
            api_key:  apiKey,
            engine:   'google',
            hl:       lang,
            gl:       lang.split('-')[0],
            num:      8
          },
          signal,
          timeout: 12000
        });

        if (resp.data && resp.data.organic_results) {
          for (const r of resp.data.organic_results.slice(0, 8)) {
            results.push({
              title:   r.title   || '',
              snippet: r.snippet || '',
              url:     r.link    || ''
            });
          }
          console.log(`  ✅ SERPApi: found ${resp.data.organic_results.length} results`);
        }
        break; // successo: esci dal retry loop
      } catch (err) {
        console.log(`  ⚠️ SERPApi error (attempt ${attempt}/${maxAttempts}): ${err.message}`);
        if (attempt < maxAttempts && !signal?.aborted) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }

  if (results.length > 0) {
    cacheSet(queryCache, cacheKey, results);
  }
  return results;
}

async function fetchHomepageFallback(rootUrl, signal = null) {
  console.log(`  🏠 Homepage fallback fetch: ${rootUrl}`);
  const cached = cacheGet(pageCache, rootUrl);
  if (cached) {
    console.log(`  ⚡ Homepage cache hit: ${rootUrl}`);
    return cached;
  }

  try {
    const resp = await axios.get(rootUrl, {
      timeout: PAGE_TIMEOUT_MS,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.1;)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      validateStatus: s => s >= 200 && s < 400
    });

    const pageData = extractPageData(resp.data, rootUrl);
    cacheSet(pageCache, rootUrl, pageData);
    return pageData;
  } catch (err) {
    console.log(`  ❌ Homepage fallback failed: ${err.message}`);
    return null;
  }
}

// ─── LIGHTWEIGHT CRAWL: Fallback intelligente quando SERPApi è scarso ────────

async function lightweightCrawl(rootUrl, queryTokens, maxPages = 8) {
  console.log(`  🕷️  Lightweight crawl (depth=1, max ${maxPages} pages)`);
  
  const results = [];
  const visited = new Set();
  
  // Fetch homepage
  try {
    const resp = await axios.get(rootUrl, {
      timeout: PAGE_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.1;)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    
    const homepage = extractPageData(resp.data, rootUrl);
    results.push(homepage);
    visited.add(rootUrl);
    
    // Trova link rilevanti dalla homepage
    const relevantLinks = homepage.namedLinks
      .filter(link => {
        const url = link.url;
        const anchor = link.text.toLowerCase();
        
        // Filtra link irrilevanti
        if (url.match(/\.(jpg|jpeg|png|gif|pdf|ico|css|js|woff)/i)) return false;
        if (anchor.includes('privacy') || anchor.includes('cookie')) return false;
        
        // Priorità ai link con keyword della query
        let score = 0;
        for (const token of queryTokens) {
          if (anchor.includes(token)) score += 10;
          if (url.toLowerCase().includes(token)) score += 5;
        }
        
        // Bonus per sezioni utili
        if (anchor.includes('contatt') || anchor.includes('serviz') || anchor.includes('info')) score += 3;
        
        return score > 0;
      })
      .slice(0, maxPages - 1); // -1 perché abbiamo già la homepage
    
    console.log(`  📋 Found ${relevantLinks.length} relevant links to crawl`);
    
    // Fetch parallelo dei link più rilevanti
    const fetchResults = await Promise.allSettled(
      relevantLinks.map(async (link) => {
        if (visited.has(link.url)) return null;
        visited.add(link.url);
        
        const cached = cacheGet(pageCache, link.url);
        if (cached) return cached;
        
        try {
          const resp = await axios.get(link.url, {
            timeout: PAGE_TIMEOUT_MS,
            maxRedirects: 5,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.1;)',
              'Accept': 'text/html,application/xhtml+xml'
            },
            validateStatus: s => s >= 200 && s < 400
          });
          
          const pageData = extractPageData(resp.data, link.url);
          cacheSet(pageCache, link.url, pageData);
          console.log(`  ✅ Crawled: ${link.url} (${pageData.rawText.length} chars)`);
          return pageData;
        } catch (err) {
          console.log(`  ⚠️  Crawl failed [${link.url}]: ${err.message}`);
          return null;
        }
      })
    );
    
    const crawledPages = fetchResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
    
    results.push(...crawledPages);
    
  } catch (err) {
    console.log(`  ❌ Lightweight crawl failed: ${err.message}`);
  }
  
  return results;
}

// ─── FLUSSO CORE: STRATEGIA A 3 LIVELLI CON FALLBACK INTELLIGENTE ────────────

async function hybridSearch(query, rootUrl, lang = 'it', signal = null) {
  const startTime = Date.now();
  const hostname = getHostname(rootUrl);
  const queryTokens = tokenize(query);
  
  console.log(`  🔬 Starting intelligent search for ${hostname}`);
  
  // ═══ LIVELLO 1: SERPApi Hybrid (IDEALE) ═══
  console.log(`  📡 LEVEL 1: Trying SERPApi...`);
  ensureTimeRemaining(startTime, 'SERPApi search');
  const serpResults = await serpApiSearch(query, hostname, lang, signal);
  
  if (serpResults.length > 0) {
    console.log(`  SERPApi returned ${serpResults.length} results → using hybrid strategy`);
    
    // Isola gli URL pertinenti che appartengono al dominio e non sono PDF/binary
    const topCandidates = serpResults
      .filter(candidate => {
        try {
          const urlObj = new URL(candidate.url);
          if (urlObj.hostname.replace(/^www\./, '') !== hostname) return false;
          if (isPdfUrl(candidate.url) || /\.(pdf|docx|xlsx|zip|gz)$/i.test(candidate.url)) return false;
          return true;
        } catch {
          return false;
        }
      })
      .map(candidate => {
        const text = `${candidate.title || ''} ${candidate.snippet || ''}`.toLowerCase();
        let score = 0;
        for (const token of queryTokens) {
          if (text.includes(token)) score += 2;
          if (candidate.url.toLowerCase().includes(token)) score += 1;
        }
        return { ...candidate, _score: score };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
    
    console.log(`  📋 Selected ${topCandidates.length} top candidates for targeted fetch (PDF/binary excluded)`);
    
    // Fetch mirato e parallelo
    const fetchResults = await Promise.allSettled(
      topCandidates.map(async (candidate) => {
        const url = candidate.url;
        const cached = cacheGet(pageCache, url);
        if (cached) {
          console.log(`  ⚡ Cache hit: ${url}`);
          if (candidate.snippet && !cached.rawText.includes(candidate.snippet)) {
            cached.rawText = `[SERP Snippet: ${candidate.snippet}]\n\n` + cached.rawText;
          }
          return cached;
        }

        if (isSnippetSufficient(candidate, queryTokens, query)) {
          console.log(`  ⏩ Skipping fetch for snippet-sufficient result: ${url}`);
          return {
            title: candidate.title || '',
            metaDesc: '',
            rawText: `[SERP Snippet Sufficient]\n${candidate.snippet || ''}`,
            headings: [],
            namedLinks: [],
            phones: [],
            emails: [],
            addresses: [],
            pageUrl: url,
            source: 'serpapi_snippet'
          };
        }

        // Difesa 1: Controllo stringa URL per PDF o estensioni binarie note
        if (isPdfUrl(url) || /\.(pdf|docx|xlsx|zip|gz)$/i.test(url)) {
          console.log(`  ⏩ Skipping binary/PDF URL by extension: ${url}`);
          return null;
        }

        try {
          const resp = await axios.get(url, {
            timeout: PAGE_TIMEOUT_MS,
            maxRedirects: 5,
            responseType: 'arraybuffer',
            signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.1;)',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'it-IT,it;q=0.9'
            },
            validateStatus: s => s >= 200 && s < 400
          });
          
          const buffer = Buffer.from(resp.data);
          
          // Difesa 2: Controllo Magic Bytes per i PDF (%PDF- -> 0x25504446)
          const isPdfMagic = buffer.length >= 4 && buffer.readUInt32BE(0) === 0x25504446;
          if (isPdfMagic || isPdfResponse(resp.headers, buffer)) {
            console.log(`  ⏩ Skipping PDF/binary response verified by magic bytes: ${url}`);
            return null;
          }

          const html = buffer.toString('utf8');
          const pageData = extractPageData(html, url);
          
          // RISOLUZIONE BUG #2: Iniettiamo lo snippet e il titolo di Google nel testo della pagina
          // In questo modo buildContext avrà SEMPRE i dati puliti di SERPApi come paracadute
          const cleanSnippet = candidate.snippet ? `[SERP Snippet: ${candidate.snippet}]\n` : '';
          const cleanTitle = candidate.title ? `[SERP Title: ${candidate.title}]\n` : '';
          
          pageData.rawText = `${cleanTitle}${cleanSnippet}\n${pageData.rawText}`;
          pageData.source = 'hybrid_fetch';

          cacheSet(pageCache, url, pageData);
          console.log(`  ✅ Fetched & Enriched: ${url} (${pageData.rawText.length} chars)`);
          return pageData;
        } catch (err) {
          console.log(`  ⚠️  Fetch failed [${url}]: ${err.message}`);
          return null;
        }
      })
    );
    
    const fetchedPages = fetchResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    // Fallback pulito: se il fetch è fallito, usiamo SOLO i dati di SERPApi
    const fetchedUrls = new Set(fetchedPages.map(p => p.pageUrl));
    const fallbackPages = topCandidates
      .filter(candidate => !fetchedUrls.has(candidate.url))
      .map(candidate => ({
        title: candidate.title || '',
        metaDesc: '',
        rawText: `[SERP Snippet Fallback]\n${candidate.snippet || ''}`,
        headings: [],
        namedLinks: [],
        phones: [],
        emails: [],
        addresses: [],
        pageUrl: candidate.url,
        source: 'serpapi_fallback'
      }));

    const pages = [...fetchedPages, ...fallbackPages];
    
    if (pages.length > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  🏁 Level 1 SUCCESS: ${pages.length} pages in ${elapsed}s`);
      return pages;
    }
  }
  
  console.log(`  ⚠️  SERPApi did not provide usable pages → LEVEL 2: Homepage-only fallback`);
  ensureTimeRemaining(startTime, 'homepage fallback');
  
  const homepage = await fetchHomepageFallback(rootUrl, signal);
  if (homepage) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  🏁 Level 2 SUCCESS: homepage fetched in ${elapsed}s`);
    return [homepage];
  }
  
  console.log(`  ❌ All search fallback levels failed for ${hostname}`);
  return [];
}

// ─── CALCOLO RILEVANZA DEI CONTENUTI ESTRATTI ────────────────────────────────

function scorePageRelevance(page, queryTokens) {
  const text = [page.title, page.metaDesc, page.headings.join(' '), page.rawText]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    const count = (text.split(token).length - 1);
    score += count;
    if (page.title.toLowerCase().includes(token)) score += 5;
    if (page.headings.join(' ').toLowerCase().includes(token)) score += 3;
  }
  return score;
}

// ─── COSTRUZIONE PROMPT DI CONTESTO ──────────────────────────────────────────

function buildContext(crawledPages, query, configuredUrls) {
  const tokens = tokenize(query);

  const scored = crawledPages
    .map(p => ({ ...p, score: scorePageRelevance(p, tokens) }))
    .sort((a, b) => b.score - a.score);

  const lines = [];
  let charCount = 0;
  const maxPages = 10; 

  for (const page of scored.slice(0, maxPages)) {
    if (charCount >= MAX_CONTEXT_CHARS) break;
    const block = [
      `### Pagina: ${page.title || page.pageUrl}`,
      `URL: ${page.pageUrl}`,
      page.metaDesc ? `Descrizione: ${page.metaDesc}` : '',
      page.headings.length > 0 ? `Sezioni: ${page.headings.slice(0, 5).join(' | ')}` : '',
      page.phones.length > 0  ? `Telefoni: ${page.phones.join(', ')}` : '',
      page.emails.length > 0  ? `Email: ${page.emails.join(', ')}` : '',
      page.addresses.length > 0 ? `Indirizzi: ${page.addresses.join('; ')}` : '',
      `Contenuto:\n${page.rawText.substring(0, 800)}`,
      ''
    ].filter(Boolean).join('\n');

    lines.push(block);
    charCount += block.length;
  }

  if (crawledPages.length > 0) {
    lines.push('\n### Link utili trovati sul sito:');
    for (const p of crawledPages.slice(0, 5)) {
      if (p.namedLinks && p.namedLinks.length > 0) {
        for (const link of p.namedLinks.slice(0, 2)) {
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

// ─── FASE 2: COMPILAZIONE SINTESI AI ─────────────────────────────────────────

async function synthesizeWithAI(query, context, configuredUrls, product, openaiClient, responseLang = 'it') {
  const siteList = configuredUrls.join(', ');
  const languageDirective = responseLang === 'it'
    ? 'Rispondi in italiano.'
    : `Rispondi in ${responseLang}, mantenendo il significato originale della domanda.`;

  const systemPrompt = `Sei un assistente esperto e sempre utile per il sito: ${siteList}
Hai a disposizione il contenuto delle pagine del sito estratti tramite una ricerca mirata ed integrata.

REGOLE ASSOLUTE:
1. Usa ESCLUSIVAMENTE le informazioni presenti nel contesto qui sotto per rispondere.
2. Cita SEMPRE URL reali trovati nel contesto — mai inventarli o ipotizzarli.
3. Se l'informazione è presente nel contesto, forniscila in modo completo e diretto.
4. Se l'informazione NON è presente, dì all'utente cosa hai trovato di più vicino e indica il link principale del sito.
5. NON dire mai "non ho trovato" senza prima dare alternative utili.
6. ${languageDirective}
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
    return `Non sono riuscito a elaborare la risposta in questo momento. Visita direttamente: ${configuredUrls[0]}`;
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

async function searchConfiguredSites(query, configuredUrls, product = 'comunicai', openaiClient) {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔎 DEEP HYBRID SEARCH ENGINE — query: "${query}"`);
  console.log(`📌 URLs: ${configuredUrls.join(' | ')}`);
  console.log(`${'═'.repeat(60)}`);

  if (!configuredUrls || configuredUrls.length === 0) {
    return `Nessun sito configurato. Contatta l'amministratore del sistema.`;
  }

  // Fase 0: Analisi iniziale query
  const queryAnalysis = await analyzeQuery(query);
  const responseLang = queryAnalysis.lang || 'it';
  let searchQuery = query;
  let searchLang = 'it';

  if (responseLang !== 'it') {
    console.log(`  🌍 Detected query language: ${responseLang}. Translating query for site search.`);
    searchQuery = await translateQueryToItalian(query, responseLang, openaiClient);
    console.log(`  🌍 Search query after translation: "${searchQuery}"`);
  }

  const deadline = Date.now() + MAX_TOTAL_TIME_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAX_TOTAL_TIME_MS);

  // Fase 1: Flusso Ibrido (SERPApi + Fetch mirati in parallelo)
  const allCrawledPages = [];
  for (const rootUrl of configuredUrls) {
    if (Date.now() >= deadline) {
      console.error(`  ❌ Overall timeout reached before searching ${rootUrl}`);
      break;
    }
    try {
      const pages = await hybridSearch(searchQuery, rootUrl, searchLang, controller.signal);
      allCrawledPages.push(...pages);
    } catch (err) {
      console.error(`  ❌ Search failed for ${rootUrl}: ${err.message}`);
    }
  }

  // Fase 2: Elaborazione del contesto e invio all'AI
  if (Date.now() >= deadline) {
    console.log('  ⚠️ Overall timeout reached before AI synthesis. Using current context only.');
  }
  let context = '';
  if (allCrawledPages.length === 0) {
    console.log(`  ⚠️ No data fetched. Using generic AI fallback.`);
    context = `Il sito ${configuredUrls.join(', ')} non era accessibile al momento della ricerca.`;
  } else {
    context = buildContext(allCrawledPages, query, configuredUrls);
  }

  const answer = await synthesizeWithAI(query, context, configuredUrls, product, openaiClient, responseLang);
  clearTimeout(timeoutId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ HYBRID DEEP SEARCH COMPLETE in ${elapsed}s`);
  console.log(`${'═'.repeat(60)}\n`);

  return answer;
}

module.exports = { searchConfiguredSites };