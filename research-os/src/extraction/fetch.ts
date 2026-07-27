import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '../lib/errors';

/**
 * Server-side request forgery guard.
 *
 * Ingestion fetches URLs supplied by users and, indirectly, by external
 * search results. Without this check the ingestion worker is a proxy into
 * the private network it runs in -- cloud metadata endpoints, internal
 * admin panels, databases on localhost.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('fe80')) return true; // link-local
    // IPv4-mapped addresses must be checked as IPv4.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  return false;
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError('INVALID_INPUT', `Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('INVALID_INPUT', `Only http and https URLs can be ingested.`, {
      details: { protocol: url.protocol },
    });
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new ApiError('INVALID_INPUT', 'This host cannot be fetched.', {
      details: { hostname },
    });
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new ApiError('INVALID_INPUT', 'This address is not publicly routable.', {
        details: { hostname },
      });
    }
    return url;
  }

  // Resolve and check every address the name maps to, so a hostname that
  // points at a private range is rejected too.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new ApiError('INVALID_INPUT', `The hostname could not be resolved: ${hostname}`, {
      details: { hostname },
    });
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ApiError('INVALID_INPUT', 'This host resolves to a private address.', {
        details: { hostname },
      });
    }
  }

  return url;
}

export interface FetchedDocument {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  headers: Record<string, string>;
}

const USER_AGENT =
  'NirogBhoomiResearchOS/1.0 (+https://research.nirogbhoomi.com; research library ingestion)';

/**
 * Fetches a document with redirects followed manually, so every hop is
 * re-checked against the SSRF guard rather than only the first URL.
 */
export async function fetchDocument(
  rawUrl: string,
  options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<FetchedDocument> {
  const maxBytes = options.maxBytes ?? 20_000_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 5;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'en',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ApiError(
        'EXTRACTION_FAILED',
        `Could not fetch the URL: ${err instanceof Error ? err.message : 'network error'}`,
        {
          details: { url: current },
          suggestedAction: 'Check that the URL is reachable, then retry the ingestion.',
        },
      );
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new ApiError('EXTRACTION_FAILED', `The URL returned HTTP ${response.status}.`, {
        details: { url: current, status: response.status },
        retryable: response.status >= 500 || response.status === 429,
        suggestedAction:
          response.status === 403 || response.status === 401
            ? 'The publisher blocked automated access. Save the article text manually instead.'
            : 'Retry later, or add the source manually if the site stays unavailable.',
      });
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new ApiError('PAYLOAD_TOO_LARGE', `The document exceeds the ${maxBytes}-byte limit.`);
    }

    // Streamed so an undeclared oversized body cannot exhaust memory.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new ApiError(
            'PAYLOAD_TOO_LARGE',
            `The document exceeds the ${maxBytes}-byte limit.`,
          );
        }
        chunks.push(value);
      }
    }

    return {
      finalUrl: response.url || current,
      status: response.status,
      contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
      body: Buffer.concat(chunks),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  throw new ApiError('EXTRACTION_FAILED', 'Too many redirects while fetching the URL.', {
    details: { url: rawUrl },
  });
}
