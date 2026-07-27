import { createHash } from 'node:crypto';

/**
 * URL normalization for duplicate detection. Two URLs that address the
 * same document should normalize to the same string, without discarding
 * anything that genuinely changes what is served.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  '_ga', '_gl', 'yclid', 'wbraid', 'gbraid', 'si', 'spm',
]);

/** Parameters that select content and must survive normalization. */
const SIGNIFICANT_PARAMS = new Set(['v', 'id', 'p', 'page', 'q', 'article', 'doi', 'pmid']);

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  // A scheme other than http(s) must be rejected outright, not silently
  // prefixed with "https://" -- that would turn "ftp://host/x" into the
  // mangled but still-parseable "https://ftp://host/x" instead of failing.
  const existingScheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (existingScheme && existingScheme !== 'http' && existingScheme !== 'https') {
    throw new Error(`Unsupported URL scheme: ${existingScheme}:`);
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';

  if (
    (url.port === '80' && url.protocol === 'http:') ||
    (url.port === '443' && url.protocol === 'https:')
  ) {
    url.port = '';
  }

  const params = new URLSearchParams();
  const keys = [...url.searchParams.keys()].sort();
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (lower.startsWith('utm_')) continue;
    for (const value of url.searchParams.getAll(key)) params.append(key, value);
  }
  url.search = params.toString();

  // A trailing slash on a path is not meaningful; on the root it is.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

export function isSignificantParam(name: string): boolean {
  return SIGNIFICANT_PARAMS.has(name.toLowerCase());
}

/** Extracts a DOI from a string or URL, normalized to lowercase bare form. */
export function extractDoi(input: string): string | null {
  const match = input.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
  if (!match) return null;
  return match[0].toLowerCase().replace(/[.,;)]+$/, '');
}

export function extractPmid(input: string): string | null {
  const direct = input.match(/\bpmid:?\s*(\d{4,9})\b/i);
  if (direct) return direct[1];
  const url = input.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})/i);
  if (url) return url[1];
  return null;
}

export function extractYouTubeId(input: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?[^#]*\bv=([\w-]{11})/i,
    /youtu\.be\/([\w-]{11})/i,
    /youtube\.com\/embed\/([\w-]{11})/i,
    /youtube\.com\/shorts\/([\w-]{11})/i,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------
// Text normalization and hashing
// ---------------------------------------------------------------------

/**
 * Collapses formatting noise so that two captures of the same article
 * hash identically even if whitespace or quoting changed.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n *"?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizedContentHash(text: string): string {
  const canonical = normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 64-bit SimHash over token shingles, for near-duplicate detection.
 * Two documents differing only in boilerplate stay within a small
 * Hamming distance of one another.
 */
export function simhash(text: string): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  const shingles: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    shingles.push(tokens.slice(i, i + 3).join(' '));
    if (i + 3 >= tokens.length) break;
  }
  const source = shingles.length > 0 ? shingles : tokens;

  const weights = new Array<number>(64).fill(0);
  for (const shingle of source) {
    const digest = createHash('md5').update(shingle).digest();
    const value = digest.readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit += 1) {
      const isSet = (value >> BigInt(bit)) & 1n;
      weights[bit] += isSet === 1n ? 1 : -1;
    }
  }

  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] > 0) result |= 1n << BigInt(bit);
  }
  // Stored in a signed BIGINT column, so wrap into the signed range.
  return BigInt.asIntN(64, result);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Average adult reading speed of roughly 220 words per minute. */
export function readingTimeMinutes(text: string): number {
  return Math.max(1, Math.round(wordCount(text) / 220));
}

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'item';
}

/**
 * Normalization used for taxonomy duplicate checks. "Physical Activity",
 * "physical-activity" and "Physical  Activities" all collapse together.
 */
export function normalizeTaxonomyName(input: string): string {
  const collapsed = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return collapsed
    .split(' ')
    .map(singularize)
    .filter((w) => w.length > 0 && !TAXONOMY_STOPWORDS.has(w))
    .join(' ');
}

const TAXONOMY_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'in', 'on']);

function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('ss')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Jaccard similarity over token sets, used for near-duplicate scoring. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
