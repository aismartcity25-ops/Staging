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

module.exports = { normalizeUrl, hostOf, registrableHost, sameSite };
