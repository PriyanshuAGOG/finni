import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ApiError } from '../lib/errors';
import {
  extractDoi,
  extractPmid,
  extractYouTubeId,
  normalizeText,
  readingTimeMinutes,
  wordCount,
} from '../lib/text';
import { fetchDocument, type FetchedDocument } from './fetch';

export interface ExtractionResult {
  title: string;
  subtitle?: string | null;
  text: string;
  html?: string | null;
  excerpt?: string | null;
  authorText?: string | null;
  publisher?: string | null;
  publicationDate?: string | null;
  language?: string | null;
  canonicalUrl?: string | null;
  faviconUrl?: string | null;
  thumbnailUrl?: string | null;
  doi?: string | null;
  pmid?: string | null;
  /** Page boundaries for PDFs, so a locator can name a page. */
  pageOffsets?: Array<{ page: number; start: number; end: number }>;
  sourceTypeHint?: string;
  confidence: number;
  warnings: string[];
}

/**
 * Extracts readable content from a fetched document, dispatching on the
 * content type it actually returned rather than on the URL's extension.
 */
export async function extractFromFetched(doc: FetchedDocument): Promise<ExtractionResult> {
  const contentType = doc.contentType.toLowerCase();

  if (contentType === 'application/pdf' || looksLikePdf(doc.body)) {
    return extractPdf(doc.body, doc.finalUrl);
  }
  if (contentType.startsWith('text/html') || contentType.includes('xhtml')) {
    return extractHtml(doc.body.toString('utf8'), doc.finalUrl);
  }
  if (contentType.startsWith('text/')) {
    return extractPlainText(doc.body.toString('utf8'), doc.finalUrl);
  }

  throw new ApiError('EXTRACTION_FAILED', `Unsupported content type: ${doc.contentType}`, {
    details: { content_type: doc.contentType },
    suggestedAction: 'Download the document and upload it as a file instead.',
  });
}

export async function extractFromUrl(url: string): Promise<ExtractionResult> {
  const youtubeId = extractYouTubeId(url);
  if (youtubeId) return extractYouTube(url, youtubeId);

  const doc = await fetchDocument(url);
  return extractFromFetched(doc);
}

function looksLikePdf(body: Buffer): boolean {
  return body.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ---------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------

export function extractHtml(html: string, url: string): ExtractionResult {
  const warnings: string[] = [];

  // Silences the noisy CSS/JS parse errors jsdom emits on real-world pages.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => undefined);
  virtualConsole.on('jsdomError', () => undefined);

  const dom = new JSDOM(html, { url, virtualConsole });
  const document = dom.window.document;

  const meta = (selector: string): string | null =>
    document.querySelector(selector)?.getAttribute('content')?.trim() || null;

  const canonicalUrl =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
    meta('meta[property="og:url"]') ||
    null;

  const publicationDate =
    meta('meta[property="article:published_time"]') ||
    meta('meta[name="citation_publication_date"]') ||
    meta('meta[name="dc.date"]') ||
    meta('meta[name="date"]') ||
    document.querySelector('time[datetime]')?.getAttribute('datetime') ||
    null;

  const citationAuthors = [...document.querySelectorAll('meta[name="citation_author"]')]
    .map((el) => el.getAttribute('content')?.trim())
    .filter((v): v is string => Boolean(v));

  const authorText =
    citationAuthors.length > 0
      ? citationAuthors.join(', ')
      : meta('meta[name="author"]') ||
        meta('meta[property="article:author"]') ||
        document.querySelector('[rel="author"]')?.textContent?.trim() ||
        null;

  const publisher =
    meta('meta[property="og:site_name"]') ||
    meta('meta[name="citation_journal_title"]') ||
    meta('meta[name="publisher"]') ||
    hostnameOf(url);

  // Readability mutates the document, so metadata is read first.
  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(document.cloneNode(true) as Document).parse();
  } catch {
    warnings.push('Readability could not parse this page; fell back to raw text extraction.');
  }

  let text = article?.textContent ? normalizeText(article.textContent) : '';
  let confidence = 0.85;

  if (wordCount(text) < 80) {
    // Either a JavaScript-rendered page or an unusual layout. Falling back
    // to the body text is noisier but better than storing nothing; the
    // low confidence flags it for a human to check.
    const fallback = normalizeText(stripNonContent(document).textContent ?? '');
    if (wordCount(fallback) > wordCount(text)) {
      text = fallback;
      confidence = 0.4;
      warnings.push(
        'The main article body could not be isolated. The text may include navigation or footer content, and the page may require a rendered browser to extract properly.',
      );
    }
  }

  if (wordCount(text) < 20) {
    throw new ApiError('EXTRACTION_FAILED', 'No readable text could be extracted from this page.', {
      details: { url, word_count: wordCount(text) },
      suggestedAction:
        'The page may require JavaScript or block automated access. Paste the article text manually instead.',
    });
  }

  const title =
    article?.title?.trim() ||
    meta('meta[property="og:title"]') ||
    meta('meta[name="citation_title"]') ||
    document.querySelector('title')?.textContent?.trim() ||
    'Untitled document';

  const combined = `${html.slice(0, 20000)} ${text.slice(0, 5000)}`;

  return {
    title,
    subtitle: meta('meta[property="og:description"]'),
    text,
    html: article?.content ?? null,
    excerpt: article?.excerpt ?? meta('meta[name="description"]'),
    authorText,
    publisher,
    publicationDate: normalizeDate(publicationDate),
    language: document.documentElement.getAttribute('lang')?.slice(0, 5) || null,
    canonicalUrl,
    faviconUrl: resolveFavicon(document, url),
    thumbnailUrl: meta('meta[property="og:image"]'),
    doi: meta('meta[name="citation_doi"]') || extractDoi(combined),
    pmid: extractPmid(combined),
    sourceTypeHint: meta('meta[name="citation_journal_title"]') ? 'research_paper' : 'web_article',
    confidence,
    warnings,
  };
}

function stripNonContent(document: Document): Element {
  const body = document.body ?? document.documentElement;
  for (const selector of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe']) {
    for (const el of [...body.querySelectorAll(selector)]) el.remove();
  }
  return body;
}

function resolveFavicon(document: Document, url: string): string | null {
  const href =
    document.querySelector('link[rel="icon"]')?.getAttribute('href') ||
    document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href');
  if (!href) {
    try {
      return `${new URL(url).origin}/favicon.ico`;
    } catch {
      return null;
    }
  }
  try {
    return new URL(href, url).toString();
  } catch {
    return null;
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Returns an ISO date, or null when the value is not a usable date. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const yearOnly = value.match(/\b(19|20)\d{2}\b/);
    return yearOnly ? `${yearOnly[0]}-01-01` : null;
  }
  const year = parsed.getUTCFullYear();
  if (year < 1800 || year > new Date().getUTCFullYear() + 2) return null;
  return parsed.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

export async function extractPdf(body: Buffer, url?: string): Promise<ExtractionResult> {
  const warnings: string[] = [];

  // Imported lazily: the library reads a sample file at module load in
  // some versions, which is undesirable at application boot.
  const pdfParse = (await import('pdf-parse')).default as (
    data: Buffer,
    options?: Record<string, unknown>,
  ) => Promise<{
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
  }>;

  const pageTexts: string[] = [];
  const parsed = await pdfParse(body, {
    // Collects per-page text so extracted passages can cite a page number.
    pagerender: async (pageData: {
      getTextContent: (o: unknown) => Promise<{ items: Array<{ str: string }> }>;
    }) => {
      const content = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      });
      const text = content.items.map((i) => i.str).join(' ');
      pageTexts.push(text);
      return `${text}\n\n`;
    },
  }).catch((err: unknown) => {
    throw new ApiError(
      'EXTRACTION_FAILED',
      `The PDF could not be parsed: ${err instanceof Error ? err.message : 'unknown error'}`,
      { suggestedAction: 'Check that the file is a valid PDF, or upload a different copy.' },
    );
  });

  const text = normalizeText(parsed.text ?? '');

  // Very little text across many pages means a scanned document. OCR is
  // the correct next step, and is left to a human decision rather than
  // run automatically on every large PDF.
  const wordsPerPage = parsed.numpages > 0 ? wordCount(text) / parsed.numpages : 0;
  if (wordsPerPage < 20) {
    warnings.push(
      `This PDF yielded only ${Math.round(wordsPerPage)} words per page, which usually means it is scanned. Native text extraction is inadequate; OCR is required before the content can be searched.`,
    );
  }

  if (wordCount(text) < 20) {
    throw new ApiError('EXTRACTION_FAILED', 'No text layer could be read from this PDF.', {
      details: { pages: parsed.numpages },
      suggestedAction:
        'The PDF appears to be scanned images. Run it through OCR and upload the searchable copy.',
    });
  }

  // Page offsets computed against the normalized text, so a stored
  // locator resolves against what is actually saved.
  const pageOffsets: Array<{ page: number; start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < pageTexts.length; i += 1) {
    const normalized = normalizeText(pageTexts[i]);
    const start = text.indexOf(normalized.slice(0, 60), cursor);
    const resolvedStart = start >= 0 ? start : cursor;
    const end = resolvedStart + normalized.length;
    pageOffsets.push({ page: i + 1, start: resolvedStart, end });
    cursor = end;
  }

  const info = (parsed.info ?? {}) as Record<string, string | undefined>;

  return {
    title: info.Title?.trim() || firstMeaningfulLine(text) || 'Untitled PDF',
    text,
    authorText: info.Author?.trim() || null,
    publisher: null,
    publicationDate: normalizeDate(info.CreationDate ?? null),
    language: null,
    canonicalUrl: url ?? null,
    doi: extractDoi(text.slice(0, 8000)),
    pmid: extractPmid(text.slice(0, 8000)),
    pageOffsets,
    sourceTypeHint: 'uploaded_pdf',
    confidence: wordsPerPage < 20 ? 0.3 : 0.8,
    warnings,
  };
}

function firstMeaningfulLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 15 && l.length < 250);
  return line ?? null;
}

// ---------------------------------------------------------------------
// Plain text and manual entry
// ---------------------------------------------------------------------

export function extractPlainText(text: string, url?: string): ExtractionResult {
  const normalized = normalizeText(text);
  return {
    title: firstMeaningfulLine(normalized) ?? 'Untitled text',
    text: normalized,
    canonicalUrl: url ?? null,
    doi: extractDoi(normalized.slice(0, 8000)),
    pmid: extractPmid(normalized.slice(0, 8000)),
    sourceTypeHint: 'manual_note',
    confidence: 1,
    warnings: [],
  };
}

// ---------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------

/**
 * Fetches a YouTube transcript through the timedtext endpoint the player
 * uses. When no transcript is published this records the video with its
 * metadata and flags that the transcript needs supplying manually, rather
 * than failing the ingestion outright.
 */
export async function extractYouTube(url: string, videoId: string): Promise<ExtractionResult> {
  const warnings: string[] = [];
  let title = `YouTube video ${videoId}`;
  let author: string | null = null;

  try {
    const oembed = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (oembed.ok) {
      const data = (await oembed.json()) as { title?: string; author_name?: string };
      if (data.title) title = data.title;
      author = data.author_name ?? null;
    }
  } catch {
    warnings.push('Video metadata could not be retrieved.');
  }

  let transcript = '';
  try {
    const response = await fetch(
      `https://video.google.com/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (response.ok) {
      const xml = await response.text();
      transcript = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
        .map((m) => decodeXmlEntities(m[1]))
        .join(' ');
    }
  } catch {
    // Handled by the empty-transcript branch below.
  }

  if (wordCount(transcript) < 20) {
    warnings.push(
      'No transcript was available for this video. The record was created with metadata only; paste the transcript into the source to make it searchable.',
    );
    return {
      title,
      text: `${title}\n\n[No transcript available. Add the transcript text to make this source searchable.]`,
      authorText: author,
      publisher: 'YouTube',
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      sourceTypeHint: 'video',
      confidence: 0.2,
      warnings,
    };
  }

  return {
    title,
    text: normalizeText(transcript),
    authorText: author,
    publisher: 'YouTube',
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    sourceTypeHint: 'video',
    confidence: 0.7,
    warnings,
  };
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// ---------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------

/** Resolves a DOI to metadata and a landing URL via Crossref. */
export async function resolveDoi(doi: string): Promise<Partial<ExtractionResult> & { url: string }> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { accept: 'application/json', 'user-agent': 'NirogBhoomiResearchOS/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new ApiError('NOT_FOUND', `No Crossref record was found for DOI ${doi}.`, {
      suggestedAction: 'Check the DOI, or add the source by URL instead.',
    });
  }

  const { message } = (await response.json()) as { message: Record<string, unknown> };
  const authors = (message.author as Array<{ given?: string; family?: string }> | undefined) ?? [];
  const dateParts = (message.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0];

  return {
    url: (message.URL as string) ?? `https://doi.org/${doi}`,
    title: (message.title as string[] | undefined)?.[0] ?? `DOI ${doi}`,
    authorText:
      authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', ') ||
      null,
    publisher: (message.publisher as string) ?? null,
    publicationDate: dateParts
      ? `${dateParts[0]}-${String(dateParts[1] ?? 1).padStart(2, '0')}-${String(dateParts[2] ?? 1).padStart(2, '0')}`
      : null,
    doi,
    excerpt: (message.abstract as string | undefined)?.replace(/<[^>]+>/g, '') ?? null,
    sourceTypeHint: 'research_paper',
  };
}

/** Resolves a PubMed identifier to metadata via NCBI esummary. */
export async function resolvePmid(pmid: string): Promise<Partial<ExtractionResult> & { url: string }> {
  const response = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) {
    throw new ApiError('NOT_FOUND', `No PubMed record was found for PMID ${pmid}.`);
  }

  const json = (await response.json()) as {
    result?: Record<string, { title?: string; source?: string; pubdate?: string; authors?: Array<{ name: string }> }>;
  };
  const record = json.result?.[pmid];
  if (!record) throw new ApiError('NOT_FOUND', `No PubMed record was found for PMID ${pmid}.`);

  return {
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    title: record.title ?? `PMID ${pmid}`,
    publisher: record.source ?? null,
    authorText: record.authors?.map((a) => a.name).join(', ') || null,
    publicationDate: normalizeDate(record.pubdate ?? null),
    pmid,
    sourceTypeHint: 'research_paper',
  };
}

export function summarizeExtraction(result: ExtractionResult) {
  return {
    wordCount: wordCount(result.text),
    readingTimeMinutes: readingTimeMinutes(result.text),
  };
}
