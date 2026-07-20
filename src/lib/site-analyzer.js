'use strict';

/**
 * site-analyzer.js — Analisi preliminare di un sito in fase di creazione
 * demo (bottone "Analizza sito" in config_*.html).
 *
 * Diverso da deep-search-engine.js: quello crawla in modo adattivo guidato
 * da una query utente durante la chat; questo fa uno scan STRUTTURALE del
 * sito, senza query, fino a 3 livelli di profondità (root=0), per mostrare
 * al commerciale la gerarchia dei contenuti e la data di ultima modifica
 * di ciascuna pagina, prima di creare la demo.
 *
 * Fonti per la data di ultima modifica, in ordine di affidabilità:
 *   1. sitemap.xml (<lastmod>) — se trovata
 *   2. header HTTP Last-Modified della risposta
 *   3. meta tag (article:modified_time / og:updated_time)
 *   4. nessuna (lastModified: null)
 */

const axios = require('axios');
const cheerio = require('cheerio');

const MAX_DEPTH = 3;
// Budget PER LIVELLO, non globale: un sito con un menu di navigazione largo
// può avere 30+ link già al livello 1. Un cap unico sul totale pagine
// verrebbe esaurito lì e il crawler non raggiungerebbe mai i livelli 2/3
// (bug osservato in test: 39 pagine trovate a depth=1, zero a depth 2/3).
// Elaborando un livello alla volta e capando ciascuno, i livelli 2 e 3 sono
// sempre esplorati, indipendentemente da quanto è "largo" il livello 1.
const MAX_PAGES_PER_LEVEL = 100;
const MAX_TOTAL_PAGES = 90; // tetto di sicurezza su tempo/carico complessivo
// Tetto per singolo genitore quando si costruisce il livello successivo:
// impedisce a una sezione "ricca di link" (es. Amministrazione Trasparente,
// che spesso incrocia link a dozzine di sottosezioni sorelle) di monopolizzare
// il budget di livello e affamare le altre sezioni del sito (bug osservato:
// intero albero annidato sotto un'unica sezione). Non si applica al livello 0
// (root -> depth 1): lì c'è un solo "genitore" (la homepage stessa) e non ha
// senso limitarne l'ampiezza di navigazione.
const MAX_LINKS_PER_PARENT = 6;
const CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 30000;

function normalizeUrl(base, href) {
  try {
    if (!href) return null;
    href = href.trim();
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
    const url = new URL(href, base);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isSameDomain(urlA, urlB) {
  try {
    const hA = new URL(urlA).hostname.replace(/^www\./, '');
    const hB = new URL(urlB).hostname.replace(/^www\./, '');
    return hA === hB;
  } catch { return false; }
}

function isBinaryUrl(url) {
  return /\.(jpg|jpeg|png|gif|pdf|docx|xlsx|zip|ico|css|js|woff|woff2|ttf|svg|mp4|mp3|webp)(\?.*)?$/i.test(url);
}

// Pagine di utilità (login/ricerca/account) senza contenuto rilevante per la
// demo: escluse a monte, prima ancora di essere messe in coda per il fetch.
// Ancorato ai segmenti di path interi (non substring) per non scartare per
// errore pagine reali come /ricercatori o /cercasi-personale.
function isUtilityUrl(url) {
  return /\/(accedi|login|log-in|signin|sign-in|logout|log-out|esci|cerca|ricerca|search|cart|carrello|account|registrati|register|iscriviti)(\/|\?|#|$)/i.test(url);
}

// ─── Sitemap ────────────────────────────────────────────────────────────────

/**
 * Cerca una sitemap XML (root /sitemap.xml, oppure referenziata in
 * robots.txt). Se è un sitemap-index, segue fino a 3 sitemap figlie.
 * Ritorna { found, sitemapUrl, lastmodByUrl: Map<normalizedUrl, isoDate> }.
 */
async function findSitemap(origin) {
  const candidates = [`${origin}/sitemap.xml`];

  try {
    const robots = await axios.get(`${origin}/robots.txt`, { timeout: PAGE_TIMEOUT_MS, validateStatus: s => s === 200 });
    const matches = String(robots.data).match(/^Sitemap:\s*(\S+)/gim) || [];
    for (const line of matches) {
      const url = line.replace(/^Sitemap:\s*/i, '').trim();
      if (url && !candidates.includes(url)) candidates.push(url);
    }
  } catch {
    // robots.txt assente o non raggiungibile: non blocca la ricerca sitemap
  }

  for (const sitemapUrl of candidates) {
    try {
      const resp = await axios.get(sitemapUrl, {
        timeout: PAGE_TIMEOUT_MS,
        validateStatus: s => s === 200,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0)' }
      });
      const contentType = (resp.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('xml') && !String(resp.data).trim().startsWith('<')) continue;

      const $ = cheerio.load(resp.data, { xmlMode: true });

      // sitemap-index: segui fino a 3 sitemap figlie e unisci i risultati
      const childSitemaps = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
      if (childSitemaps.length > 0) {
        const lastmodByUrl = new Map();
        for (const childUrl of childSitemaps.slice(0, 3)) {
          try {
            const childResp = await axios.get(childUrl, { timeout: PAGE_TIMEOUT_MS, validateStatus: s => s === 200 });
            const $$ = cheerio.load(childResp.data, { xmlMode: true });
            $$('urlset > url').each((_, el) => {
              const loc = $$(el).find('loc').first().text().trim();
              const lastmod = $$(el).find('lastmod').first().text().trim();
              const normalized = normalizeUrl(origin, loc);
              if (normalized && lastmod) lastmodByUrl.set(normalized, lastmod);
            });
          } catch {
            // sitemap figlia non raggiungibile: ignora, prosegui con le altre
          }
        }
        return { found: true, sitemapUrl, lastmodByUrl };
      }

      // sitemap flat
      const lastmodByUrl = new Map();
      $('urlset > url').each((_, el) => {
        const loc = $(el).find('loc').first().text().trim();
        const lastmod = $(el).find('lastmod').first().text().trim();
        const normalized = normalizeUrl(origin, loc);
        if (normalized && lastmod) lastmodByUrl.set(normalized, lastmod);
      });
      if (lastmodByUrl.size > 0 || $('urlset').length > 0) {
        return { found: true, sitemapUrl, lastmodByUrl };
      }
    } catch {
      // candidato non valido/non raggiungibile: prova il prossimo
    }
  }

  return { found: false, sitemapUrl: null, lastmodByUrl: new Map() };
}

// ─── Feed (RSS/Atom) ──────────────────────────────────────────────────────────

const FEED_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/atom.xml', '/index.xml'];

/** Ritorna { found, feedUrl, lastUpdated } cercando un feed RSS/Atom comune. */
async function findFeed(origin) {
  for (const p of FEED_PATHS) {
    try {
      const resp = await axios.get(`${origin}${p}`, {
        timeout: PAGE_TIMEOUT_MS,
        validateStatus: s => s === 200,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0)' }
      });
      const contentType = (resp.headers['content-type'] || '').toLowerCase();
      const body = String(resp.data);
      const looksLikeFeed = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom') || /<rss[\s>]|<feed[\s>]/i.test(body.slice(0, 500));
      if (!looksLikeFeed) continue;

      const $ = cheerio.load(body, { xmlMode: true });
      const lastUpdated =
        $('rss > channel > lastBuildDate').first().text().trim() ||
        $('rss > channel > pubDate').first().text().trim() ||
        $('feed > updated').first().text().trim() ||
        null;

      return { found: true, feedUrl: `${origin}${p}`, lastUpdated: lastUpdated || null };
    } catch {
      // path non valido/non raggiungibile: prova il prossimo
    }
  }
  return { found: false, feedUrl: null, lastUpdated: null };
}

// ─── Estrazione dati pagina (titolo, link, segnali di data) ──────────────────

const ITALIAN_MONTHS = {
  gennaio: 1, gen: 1,
  febbraio: 2, feb: 2,
  marzo: 3, mar: 3,
  aprile: 4, apr: 4,
  maggio: 5, mag: 5,
  giugno: 6, giu: 6,
  luglio: 7, lug: 7,
  agosto: 8, ago: 8,
  settembre: 9, set: 9,
  ottobre: 10, ott: 10,
  novembre: 11, nov: 11,
  dicembre: 12, dic: 12
};

// Molti siti (soprattutto PA italiane) mostrano un testo esplicito tipo
// "Ultimo aggiornamento: 15/07/2026" direttamente nella pagina: è un segnale
// più affidabile di sitemap <lastmod>/header Last-Modified/meta tag, che
// spesso sono sbagliati o non aggiornati dal CMS (osservato: date da
// sitemap/header non corrispondenti alla data reale dichiarata in pagina).
const VISIBLE_DATE_LABEL_REGEX = /\b(?:ultimo\s+aggiornamento|ultima\s+modifica|aggiornat[oa]\s+il|data\s+(?:di\s+)?(?:ultimo\s+aggiornamento|ultima\s+modifica))[^0-9a-zA-Zàèéìòù]{0,15}(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[a-zàèéìòù]{3,9}\s+\d{4})/i;

function parseItalianVisibleDate(raw) {
  const numeric = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (numeric) {
    let [, d, m, y] = numeric.map(Number);
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  const textual = raw.match(/^(\d{1,2})\s+([a-zàèéìòù]{3,9})\s+(\d{4})$/i);
  if (textual) {
    const [, d, monthName, y] = textual;
    const m = ITALIAN_MONTHS[monthName.toLowerCase()];
    if (!m) return null;
    const date = new Date(Date.UTC(Number(y), m - 1, Number(d)));
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function extractVisibleLastModified(pageText) {
  // Molti CMS mettono l'etichetta ("Ultimo aggiornamento") e la data in tag
  // fratelli separati (es. <h2>Ultimo aggiornamento</h2> ... <p>08/04/2026</p>):
  // cheerio $('body').text() preserva l'indentazione/newline HTML tra i due
  // come testo, che può superare abbondantemente il gap massimo ammesso dalla
  // regex. Normalizzando ogni sequenza di whitespace a uno spazio singolo,
  // la distanza reale (label -> data) torna minima indipendentemente da
  // quanto sia indentato/annidato il markup originale.
  const normalized = pageText.replace(/\s+/g, ' ');
  const match = normalized.match(VISIBLE_DATE_LABEL_REGEX);
  if (!match) return null;
  return parseItalianVisibleDate(match[1].trim());
}

function extractPageInfo(html, headers, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, img, video, audio').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || pageUrl;

  const metaModified =
    $('meta[property="article:modified_time"]').attr('content') ||
    $('meta[property="og:updated_time"]').attr('content') ||
    $('meta[name="last-modified"]').attr('content') ||
    null;

  const headerModified = headers && headers['last-modified'] ? headers['last-modified'] : null;
  const visibleModified = extractVisibleLastModified($('body').text());

  const links = [];
  $('a[href]').each((_, el) => {
    const resolved = normalizeUrl(pageUrl, $(el).attr('href'));
    if (resolved && isSameDomain(resolved, pageUrl) && !isBinaryUrl(resolved) && !isUtilityUrl(resolved)) links.push(resolved);
  });

  return { title, links: [...new Set(links)], metaModified, headerModified, visibleModified };
}

// Safety net: alcune pagine di utilità (login/ricerca) hanno URL che non
// combaciano con isUtilityUrl (es. slug generato, redirect, query string non
// standard). Se il titolo/H1 estratto corrisponde (quasi) esattamente a uno
// di questi titoli generici, scartiamo la pagina e NON scendiamo nei suoi
// link (i link di una pagina di login/ricerca raramente sono contenuto
// reale). Il confronto tronca al primo separatore di titolo (es. "Accedi |
// Comune di Lugo" -> "accedi") per non scartare pagine reali che contengono
// solo di striscio una di queste parole (es. "Ricerca avanzata contratti").
const UTILITY_TITLES = new Set([
  'accedi', 'login', 'log in', 'sign in', 'signin',
  'esci', 'logout', 'log out',
  'cerca', 'search', 'ricerca'
]);

function isUtilityTitle(title) {
  if (!title) return false;
  const normalized = title.split(/[|\-–—:•·]/)[0].trim().toLowerCase();
  return UTILITY_TITLES.has(normalized);
}

// ─── Crawl strutturale, un livello alla volta, fino a MAX_DEPTH ──────────────

async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: PAGE_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SiteAssistantBot/2.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
    }
  });
  const contentType = (resp.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('html')) return null;
  return extractPageInfo(resp.data, resp.headers, url);
}

/** Scarica un elenco di { url, parentUrl } con concorrenza limitata. */
async function fetchLevel(items) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async ({ url, parentUrl }) => {
      const info = await fetchPage(url);
      return { url, parentUrl, info };
    }));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.info) results.push(r.value);
    }
  }
  return results;
}

async function crawlStructure(rootUrl) {
  const root = normalizeUrl(rootUrl, rootUrl) || rootUrl;
  const visited = new Set([root]);
  const pages = [];
  const startTime = Date.now();

  let currentLevel = [{ url: root, parentUrl: null }];

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (currentLevel.length === 0) break;
    if (Date.now() - startTime > TOTAL_BUDGET_MS) break;
    if (pages.length >= MAX_TOTAL_PAGES) break;

    // Il livello 0 è sempre solo la root; dal livello 1 in poi si cappa per
    // non far esplodere il numero di richieste su siti con molti link.
    const levelCap = depth === 0 ? 1 : Math.min(MAX_PAGES_PER_LEVEL, MAX_TOTAL_PAGES - pages.length);
    const levelItems = currentLevel
      .filter(item => !isBinaryUrl(item.url))
      .slice(0, levelCap);

    const fetched = await fetchLevel(levelItems);

    const linksByParent = new Map(); // Map<parentUrl(=url), string[]>, in ordine di scoperta
    for (const { url, parentUrl, info } of fetched) {
      if (isUtilityTitle(info.title)) continue; // pagina di utilità: scartata, niente discesa nei suoi link

      pages.push({ url, depth, parentUrl, title: info.title, metaModified: info.metaModified, headerModified: info.headerModified, visibleModified: info.visibleModified });

      if (depth < MAX_DEPTH) {
        const kept = [];
        for (const link of info.links) {
          if (!visited.has(link)) {
            visited.add(link);
            kept.push(link);
          }
        }
        if (kept.length > 0) linksByParent.set(url, kept);
      }
    }

    // Merge round-robin tra i gruppi per genitore, così un genitore "largo"
    // non monopolizza nextLevel prima ancora che lo slice(0, levelCap) del
    // prossimo giro possa campionare le altre sezioni (vedi commento su
    // MAX_LINKS_PER_PARENT). Al livello 0 c'è un solo genitore (la homepage),
    // quindi il cap per-genitore non si applica.
    const nextLevel = [];
    const parentGroups = [...linksByParent.entries()].map(([parentUrl, links]) => ({
      parentUrl,
      links: depth === 0 ? links : links.slice(0, MAX_LINKS_PER_PARENT)
    }));
    for (let round = 0; parentGroups.some(g => round < g.links.length); round++) {
      for (const group of parentGroups) {
        if (round < group.links.length) nextLevel.push({ url: group.links[round], parentUrl: group.parentUrl });
      }
    }

    currentLevel = nextLevel;
  }

  return pages;
}

/** Costruisce il breadcrumb (titoli dalla root alla pagina) risalendo i parentUrl. */
function buildBreadcrumb(page, pagesByUrl) {
  const chain = [];
  let current = page;
  const seen = new Set();
  while (current && !seen.has(current.url)) {
    seen.add(current.url);
    chain.unshift(current.title || current.url);
    current = current.parentUrl ? pagesByUrl.get(current.parentUrl) : null;
  }
  return chain;
}

/**
 * analyzeSite(rootUrl) — entry point.
 *
 * Ritorna:
 * {
 *   success, rootUrl,
 *   sitemap: { found, sitemapUrl },
 *   feed: { found, feedUrl, lastUpdated },
 *   totalPages,
 *   pages: [{ url, title, depth, parentUrl, breadcrumb, lastModified, lastModifiedSource }],
 *   elapsedMs
 * }
 */
async function analyzeSite(rootUrl) {
  const startTime = Date.now();
  const origin = new URL(rootUrl).origin;

  const [sitemapResult, feedResult, crawledPages] = await Promise.all([
    findSitemap(origin).catch(() => ({ found: false, sitemapUrl: null, lastmodByUrl: new Map() })),
    findFeed(origin).catch(() => ({ found: false, feedUrl: null, lastUpdated: null })),
    crawlStructure(rootUrl)
  ]);

  const pagesByUrl = new Map(crawledPages.map(p => [p.url, p]));

  const pages = crawledPages
    .sort((a, b) => a.depth - b.depth)
    .map(p => {
      let lastModified = null;
      let lastModifiedSource = null;

      if (p.visibleModified) {
        lastModified = p.visibleModified;
        lastModifiedSource = 'page-text';
      } else if (sitemapResult.lastmodByUrl.has(p.url)) {
        lastModified = sitemapResult.lastmodByUrl.get(p.url);
        lastModifiedSource = 'sitemap';
      } else if (p.headerModified) {
        lastModified = p.headerModified;
        lastModifiedSource = 'header';
      } else if (p.metaModified) {
        lastModified = p.metaModified;
        lastModifiedSource = 'meta';
      }

      return {
        url: p.url,
        title: p.title,
        depth: p.depth,
        parentUrl: p.parentUrl,
        breadcrumb: buildBreadcrumb(p, pagesByUrl),
        lastModified,
        lastModifiedSource
      };
    });

  return {
    success: true,
    rootUrl,
    sitemap: { found: sitemapResult.found, sitemapUrl: sitemapResult.sitemapUrl },
    feed: { found: feedResult.found, feedUrl: feedResult.feedUrl, lastUpdated: feedResult.lastUpdated },
    totalPages: pages.length,
    pages,
    elapsedMs: Date.now() - startTime
  };
}

module.exports = { analyzeSite };
