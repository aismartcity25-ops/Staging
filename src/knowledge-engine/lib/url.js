'use strict';

/**
 * URL canonicalization shared by the frontier and the dedup index.
 * Kept dependency-free (WHATWG URL only) so it can be unit tested in
 * isolation from the crawler.
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'igshid'
]);

const SKIP_PROTOCOLS = ['mailto:', 'tel:', 'javascript:', 'sms:', 'whatsapp:', 'data:', 'ftp:'];

const BINARY_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.dmg', '.exe',
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg', '.webm',
  '.css', '.js', '.mjs', '.woff', '.woff2', '.ttf', '.eot', '.json', '.xml'
]);

const DEFAULT_PORT = { 'http:': '80', 'https:': '443' };

// Path segments that, across the institutional/business sites this product
// builds demos from (comuni, cliniche, attività), almost always mean
// time-sensitive news/press content (an old road-closure notice, a press
// release) rather than the stable reference info a chatbot needs (hours,
// services, contacts, staff). Deliberately narrow: doesn't include "eventi"
// since event listings are often genuinely useful (esp. for the tourism
// product), only unambiguous news/press sections.
const NEWS_LIKE_PATH_PATTERN = /(^|\/)(novita|notizie|news|comunicat[oi]|comunicati-stampa|avvisi|press|press-release|blog|articoli|article)(\/|$)/i;

/** True if the URL's path looks like a news/press-release section rather than stable reference content. */
function isNewsLikePath(url) {
  try {
    const pathname = new URL(url).pathname;
    return NEWS_LIKE_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

// Institutional CMS platforms (Drupal and similar, common across comune/
// clinica sites) commonly serve binary downloads (PDFs, docs) behind a
// path with no file extension at all — e.g. /media/1891 — so
// BINARY_EXTENSIONS can't exclude them before they're fetched. A sitemap
// that lists thousands of these alongside real content pages, all at the
// same discovery-tier priority, can bury the real pages behind a long
// run of downloads. Not a hard exclude (occasionally a real page does
// live at such a path) — see isLikelyNonPagePath, used only to
// deprioritize, never to skip.
const LIKELY_NON_PAGE_PATH_PATTERN = /(^|\/)(media|file|files|document[oi]?|documenti|allegat[oi]|attachment[si]?|download[s]?|asset[s]?|risorsa|risorse)\/\d+(\/|$)/i;

/** True if the URL's path looks like a bare-ID binary download (e.g. /media/1891) rather than a content page. */
function isLikelyNonPagePath(url) {
  try {
    const pathname = new URL(url).pathname;
    return LIKELY_NON_PAGE_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Canonicalize a URL for queueing/dedup purposes. Returns null only for
 * URLs that are structurally impossible to crawl (bad scheme, malformed,
 * points at a binary asset) — never based on content quality.
 */
function normalizeUrl(raw, base) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const lower = trimmed.toLowerCase();
  if (SKIP_PROTOCOLS.some((p) => lower.startsWith(p))) return null;

  let u;
  try {
    u = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();
  if (DEFAULT_PORT[u.protocol] === u.port) u.port = '';

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of sorted) u.searchParams.append(k, v);

  const pathLower = u.pathname.toLowerCase();
  const dot = pathLower.lastIndexOf('.');
  if (dot !== -1 && BINARY_EXTENSIONS.has(pathLower.slice(dot))) return null;

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Strips a leading "www." so "www.example.com" and "example.com" are treated as the same site. */
function registrableHost(host) {
  return host && host.startsWith('www.') ? host.slice(4) : host;
}

function sameSite(hostA, hostB) {
  return registrableHost(hostA) === registrableHost(hostB);
}

module.exports = { normalizeUrl, hostOf, registrableHost, sameSite, isNewsLikePath, isLikelyNonPagePath };
