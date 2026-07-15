'use strict';

/**
 * extraction/document.js — Document Extraction stage.
 *
 * Turns raw fetched HTML into a clean-text document + outgoing links.
 * This module knows nothing about the crawl frontier, chunking, or
 * storage — it is a pure function of (html, url) in, {doc, links} out.
 *
 * No quality judgement happens here: extraction always returns whatever
 * text it can find, however short. Deciding whether text is "good
 * enough" is the chunking stage's job, applied per-chunk.
 */

const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const cheerio = require('cheerio');
const { normalizeUrl } = require('../lib/url');

const BOILERPLATE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template',
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.cookie', '.cookies', '.cookie-banner', '#cookie-banner', '.cookie-consent',
  '.nav', '.navbar', '.menu', '.sidebar', '.breadcrumb', '.breadcrumbs',
  '.ads', '.advertisement', '.social-share', '.share-buttons'
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Readability's own article extraction — best for article/blog-style pages. */
function extractWithReadability(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent) return null;
    return normalizeText(article.textContent);
  } catch {
    return null;
  }
}

/** Boilerplate-stripped full-body text — a fallback for pages Readability can't parse as an "article" (listings, portals, forms). */
function extractWithBoilerplateStrip($) {
  const $doc = $.root().clone();
  for (const sel of BOILERPLATE_SELECTORS) {
    try { $doc.find(sel).remove(); } catch {}
  }
  const parts = [];
  $doc.find('h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  return normalizeText(parts.join('\n\n'));
}

function extractLinks($, baseUrl) {
  const out = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) out.add(normalized);
  });
  return [...out];
}

function extractMeta($, url) {
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';
  const description = $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || '';
  const lang = $('html').attr('lang') || '';
  const canonicalHref = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonicalHref ? normalizeUrl(canonicalHref, url) : null;
  return { title, description, lang, canonicalUrl };
}

/**
 * Extracts a clean-text document + outgoing links from fetched HTML.
 * Always returns a document, even if the text is empty/short — the
 * crawler persists it regardless; quality is judged later, per chunk.
 */
function extractDocument(html, url) {
  const $ = cheerio.load(html);
  const meta = extractMeta($, url);
  const links = extractLinks($, url);

  let text = extractWithReadability(html, url);
  const boilerplateStripped = extractWithBoilerplateStrip($);
  if (!text || boilerplateStripped.length > text.length * 1.4) {
    text = boilerplateStripped;
  }

  return {
    url,
    canonicalUrl: meta.canonicalUrl || url,
    title: meta.title,
    description: meta.description,
    lang: meta.lang,
    text: text || '',
    links
  };
}

module.exports = { extractDocument, normalizeText };
