import { getEnv } from '../lib/env';
import { ApiError } from '../lib/errors';
import { normalizeDate } from './extract';

export interface ExternalHit {
  url: string;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  snippet: string | null;
  doi: string | null;
  sourceTypeHint: string | null;
  studyDesign: string | null;
  relevanceReason: string;
  keyLimitation: string | null;
  score: number;
  provider: string;
}

export interface ExternalSearchOptions {
  limit?: number;
  publishedAfter?: string | null;
  publishedBefore?: string | null;
}

/**
 * External discovery across the configured providers.
 *
 * PubMed is always queried because it needs no API key and is the highest
 * signal source for this domain. A general web provider is added when one
 * is configured. Results are deduplicated by URL and returned as
 * candidates -- never as library records.
 */
export async function externalSearch(
  queries: string[],
  options: ExternalSearchOptions = {},
): Promise<ExternalHit[]> {
  const env = getEnv();
  const limit = options.limit ?? 20;
  const perQuery = Math.max(5, Math.ceil(limit / Math.max(queries.length, 1)));

  const collected = new Map<string, ExternalHit>();

  for (const query of queries) {
    let hits: ExternalHit[] = [];
    try {
      hits = await searchPubMed(query, { ...options, limit: perQuery });
    } catch (err) {
      // One provider failing must not abort discovery entirely.
      if (queries.length === 1 && env.SEARCH_PROVIDER === 'none') throw err;
    }

    if (env.SEARCH_PROVIDER !== 'none') {
      try {
        hits.push(...(await searchWebProvider(query, { ...options, limit: perQuery })));
      } catch {
        // Same reasoning: degrade rather than fail.
      }
    }

    for (const hit of hits) {
      const key = hit.doi ? `doi:${hit.doi}` : hit.url.toLowerCase();
      const existing = collected.get(key);
      // A result found by more than one query is more likely relevant.
      if (existing) existing.score = Math.min(1, existing.score + 0.1);
      else collected.set(key, hit);
    }
  }

  return [...collected.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------
// PubMed (no credential required)
// ---------------------------------------------------------------------

async function searchPubMed(
  query: string,
  options: ExternalSearchOptions,
): Promise<ExternalHit[]> {
  const limit = Math.min(options.limit ?? 10, 25);
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(limit),
    retmode: 'json',
    sort: 'relevance',
  });

  if (options.publishedAfter || options.publishedBefore) {
    params.set('datetype', 'pdat');
    params.set('mindate', (options.publishedAfter ?? '1900-01-01').replace(/-/g, '/'));
    params.set('maxdate', (options.publishedBefore ?? new Date().toISOString().slice(0, 10)).replace(/-/g, '/'));
  }

  const searchResponse = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!searchResponse.ok) {
    throw new ApiError('EXTERNAL_SEARCH_FAILED', `PubMed search returned ${searchResponse.status}.`, {
      suggestedAction: 'Retry the search. If it keeps failing, report the outage.',
    });
  }

  const searchJson = (await searchResponse.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  const ids = searchJson.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const summaryResponse = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!summaryResponse.ok) return [];

  const summaryJson = (await summaryResponse.json()) as {
    result?: Record<
      string,
      {
        uid?: string;
        title?: string;
        source?: string;
        pubdate?: string;
        authors?: Array<{ name: string }>;
        pubtype?: string[];
        articleids?: Array<{ idtype: string; value: string }>;
      }
    >;
  };

  const hits: ExternalHit[] = [];
  for (const [index, id] of ids.entries()) {
    const record = summaryJson.result?.[id];
    if (!record?.title) continue;

    const doi = record.articleids?.find((a) => a.idtype === 'doi')?.value ?? null;
    const pubTypes = record.pubtype ?? [];
    const { sourceType, design } = classifyPubTypes(pubTypes);

    hits.push({
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      title: record.title.replace(/\.$/, ''),
      publisher: record.source ?? 'PubMed',
      publicationDate: normalizeDate(record.pubdate ?? null),
      snippet: record.authors?.length
        ? `${record.authors.slice(0, 3).map((a) => a.name).join(', ')}${record.authors.length > 3 ? ' et al.' : ''}`
        : null,
      doi,
      sourceTypeHint: sourceType,
      studyDesign: design,
      relevanceReason: `Matched a PubMed search for "${query}"${pubTypes.length > 0 ? ` (indexed as: ${pubTypes.join(', ')})` : ''}.`,
      keyLimitation:
        design === null
          ? 'The study design is not indicated in the PubMed record and must be checked in the full text.'
          : null,
      // Rank order from a relevance-sorted provider, decaying with position.
      score: Number(Math.max(0.3, 1 - index * 0.03).toFixed(3)),
      provider: 'pubmed',
    });
  }

  return hits;
}

function classifyPubTypes(pubTypes: string[]): {
  sourceType: string | null;
  design: string | null;
} {
  const lower = pubTypes.map((t) => t.toLowerCase());
  if (lower.some((t) => t.includes('meta-analysis'))) {
    return { sourceType: 'meta_analysis', design: 'meta-analysis' };
  }
  if (lower.some((t) => t.includes('systematic review'))) {
    return { sourceType: 'systematic_review', design: 'systematic review' };
  }
  if (lower.some((t) => t.includes('randomized controlled trial'))) {
    return { sourceType: 'randomized_controlled_trial', design: 'randomized controlled trial' };
  }
  if (lower.some((t) => t.includes('clinical trial'))) {
    return { sourceType: 'research_paper', design: 'clinical trial' };
  }
  if (lower.some((t) => t.includes('guideline') || t.includes('practice guideline'))) {
    return { sourceType: 'clinical_guideline', design: 'clinical guideline' };
  }
  if (lower.some((t) => t.includes('observational'))) {
    return { sourceType: 'cohort_study', design: 'observational study' };
  }
  if (lower.some((t) => t.includes('review'))) {
    return { sourceType: 'research_paper', design: 'narrative review' };
  }
  return { sourceType: 'research_paper', design: null };
}

// ---------------------------------------------------------------------
// General web providers
// ---------------------------------------------------------------------

async function searchWebProvider(
  query: string,
  options: ExternalSearchOptions,
): Promise<ExternalHit[]> {
  const env = getEnv();
  if (!env.SEARCH_API_KEY) {
    throw new ApiError(
      'EXTERNAL_SEARCH_FAILED',
      `SEARCH_API_KEY must be set when SEARCH_PROVIDER is ${env.SEARCH_PROVIDER}.`,
    );
  }

  if (env.SEARCH_PROVIDER === 'brave') {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${options.limit ?? 10}`,
      {
        headers: { accept: 'application/json', 'x-subscription-token': env.SEARCH_API_KEY },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new ApiError('EXTERNAL_SEARCH_FAILED', `Brave search returned ${response.status}.`);
    }
    const json = (await response.json()) as {
      web?: { results?: Array<{ url: string; title: string; description?: string; age?: string }> };
    };
    return (json.web?.results ?? []).map((r, index) => ({
      url: r.url,
      title: r.title,
      publisher: hostnameOf(r.url),
      publicationDate: normalizeDate(r.age ?? null),
      snippet: r.description ?? null,
      doi: null,
      sourceTypeHint: 'web_article',
      studyDesign: null,
      relevanceReason: `Matched a web search for "${query}".`,
      keyLimitation:
        'A general web result. Confirm whether it reports original research or commentary before relying on it.',
      score: Number(Math.max(0.2, 0.8 - index * 0.03).toFixed(3)),
      provider: 'brave',
    }));
  }

  if (env.SEARCH_PROVIDER === 'tavily') {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: env.SEARCH_API_KEY,
        query,
        max_results: options.limit ?? 10,
        search_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new ApiError('EXTERNAL_SEARCH_FAILED', `Tavily search returned ${response.status}.`);
    }
    const json = (await response.json()) as {
      results?: Array<{ url: string; title: string; content?: string; score?: number; published_date?: string }>;
    };
    return (json.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      publisher: hostnameOf(r.url),
      publicationDate: normalizeDate(r.published_date ?? null),
      snippet: r.content ?? null,
      doi: null,
      sourceTypeHint: 'web_article',
      studyDesign: null,
      relevanceReason: `Matched a web search for "${query}".`,
      keyLimitation:
        'A general web result. Confirm whether it reports original research or commentary before relying on it.',
      score: Number((r.score ?? 0.5).toFixed(3)),
      provider: 'tavily',
    }));
  }

  return [];
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
