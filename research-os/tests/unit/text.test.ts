import { describe, expect, it } from 'vitest';
import {
  normalizeUrl,
  normalizeTaxonomyName,
  jaccardSimilarity,
  simhash,
  hammingDistance,
  contentHash,
  normalizedContentHash,
  extractDoi,
  extractPmid,
  extractYouTubeId,
  slugify,
} from '../../src/lib/text';

describe('normalizeUrl', () => {
  it('lowercases the host and strips www', () => {
    expect(normalizeUrl('https://WWW.Example.com/Path')).toBe('https://example.com/Path');
  });

  it('strips tracking parameters but keeps significant ones', () => {
    const result = normalizeUrl('https://example.com/article?utm_source=x&id=42&ref=abc');
    expect(result).toBe('https://example.com/article?id=42');
  });

  it('produces the same result regardless of query parameter order', () => {
    const a = normalizeUrl('https://example.com/a?b=1&a=2');
    const b = normalizeUrl('https://example.com/a?a=2&b=1');
    expect(a).toBe(b);
  });

  it('removes a trailing slash on a non-root path', () => {
    expect(normalizeUrl('https://example.com/article/')).toBe('https://example.com/article');
  });

  it('keeps the root path slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('removes the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('adds a scheme when missing', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a');
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => normalizeUrl('ftp://example.com/a')).toThrow();
  });

  it('rejects an unparsable string', () => {
    expect(() => normalizeUrl('not a url at all::::')).toThrow();
  });
});

describe('normalizeTaxonomyName', () => {
  it('treats case, punctuation and plurals as equivalent', () => {
    expect(normalizeTaxonomyName('Physical Activity')).toBe(normalizeTaxonomyName('physical-activities'));
  });

  it('drops filler words', () => {
    expect(normalizeTaxonomyName('The Diabetes Complications')).toBe(
      normalizeTaxonomyName('Diabetes Complications'),
    );
  });

  it('does not collapse genuinely different names', () => {
    expect(normalizeTaxonomyName('Physical Activity')).not.toBe(normalizeTaxonomyName('Sleep Duration'));
  });
});

describe('slugify', () => {
  it('produces a lowercase, hyphenated slug', () => {
    expect(slugify('Post-Meal Walking!')).toBe('post-meal-walking');
  });

  it('never returns an empty string', () => {
    expect(slugify('!!!')).toBe('item');
  });
});

describe('content hashing', () => {
  it('is stable for identical text', () => {
    expect(contentHash('Hello world')).toBe(contentHash('Hello world'));
  });

  it('differs for different text', () => {
    expect(contentHash('Hello world')).not.toBe(contentHash('Hello World!'));
  });

  it('normalizedContentHash ignores punctuation and case differences', () => {
    expect(normalizedContentHash('Hello, World!')).toBe(normalizedContentHash('hello world'));
  });

  it('normalizedContentHash still distinguishes different content', () => {
    expect(normalizedContentHash('Walking reduces glucose.')).not.toBe(
      normalizedContentHash('Walking increases glucose.'),
    );
  });
});

describe('simhash / hammingDistance', () => {
  it('gives near-identical documents a small Hamming distance', () => {
    // Differs only in whitespace and a trailing boilerplate sentence --
    // the kind of variation between two captures of the same page.
    const a = simhash(
      'Post-meal walking for fifteen minutes reduces postprandial glucose excursions in adults with type 2 diabetes. This finding was consistent across all study sites.',
    );
    const b = simhash(
      'Post-meal walking for fifteen minutes reduces postprandial  glucose excursions in adults with type 2 diabetes.   This finding was consistent across all study sites.',
    );
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(10);
  });

  it('gives unrelated documents a larger Hamming distance', () => {
    const a = simhash(
      'Post-meal walking for fifteen minutes reduces postprandial glucose excursions in adults with type 2 diabetes.',
    );
    const b = simhash(
      'The quarterly marketing budget review meeting has been rescheduled to next Thursday afternoon in the main office.',
    );
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
  });

  it('hammingDistance is symmetric', () => {
    const a = simhash('some example text here');
    const b = simhash('a different example altogether');
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});

describe('jaccardSimilarity', () => {
  it('is 1 for identical text', () => {
    expect(jaccardSimilarity('walking reduces glucose', 'walking reduces glucose')).toBe(1);
  });

  it('is 0 for completely disjoint text', () => {
    expect(jaccardSimilarity('apple banana cherry', 'dog elephant fox')).toBe(0);
  });

  it('increases with overlap', () => {
    const low = jaccardSimilarity('apple banana cherry date', 'apple zebra yak fox');
    const high = jaccardSimilarity('apple banana cherry date', 'apple banana cherry fox');
    expect(high).toBeGreaterThan(low);
  });
});

describe('identifier extraction', () => {
  it('extracts a DOI from surrounding text', () => {
    expect(extractDoi('See https://doi.org/10.1234/abcd.5678 for details.')).toBe('10.1234/abcd.5678');
  });

  it('returns null when no DOI is present', () => {
    expect(extractDoi('No identifier here.')).toBeNull();
  });

  it('extracts a PMID labelled explicitly', () => {
    expect(extractPmid('PMID: 35449236')).toBe('35449236');
  });

  it('extracts a PMID from a PubMed URL', () => {
    expect(extractPmid('https://pubmed.ncbi.nlm.nih.gov/35449236/')).toBe('35449236');
  });

  it('extracts a YouTube video id from several URL forms', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for a non-YouTube URL', () => {
    expect(extractYouTubeId('https://example.com/video')).toBeNull();
  });
});
