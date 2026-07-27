import { describe, expect, it } from 'vitest';
import { formatCitation, type GatheredSource } from '../../src/services/synthesis';
import { validateCitations } from '../../src/ai/pipeline';

const SOURCE: GatheredSource = {
  id: 'src-1',
  title: 'Post-meal walking and glucose control',
  author_text: 'Sharma A, Gupta R',
  publisher: 'Journal of Metabolic Health',
  journal: 'Journal of Metabolic Health',
  publication_date: '2022-03-01',
  doi: '10.1234/jmh.2022.001',
  canonical_url: 'https://example.com/article',
  review_status: 'approved',
  source_type: 'randomized_controlled_trial',
  marker: '[1]',
};

describe('formatCitation', () => {
  it('numbered style includes review status and a link', () => {
    const result = formatCitation(SOURCE, 'numbered', '[1]');
    expect(result).toContain('[1]');
    expect(result).toContain('approved');
    expect(result).toContain('https://example.com/article');
  });

  it('apa style includes authors and year', () => {
    const result = formatCitation(SOURCE, 'apa', '[1]');
    expect(result).toContain('Sharma A, Gupta R');
    expect(result).toContain('2022');
  });

  it('doi_list returns only the DOI', () => {
    expect(formatCitation(SOURCE, 'doi_list', '[1]')).toBe('10.1234/jmh.2022.001');
  });

  it('doi_list reports missing DOI honestly rather than inventing one', () => {
    const noDoi = { ...SOURCE, doi: null };
    expect(formatCitation(noDoi, 'doi_list', '[1]')).toBe('(no DOI recorded)');
  });

  it('bibtex only emits fields that are actually present', () => {
    const sparse: GatheredSource = {
      ...SOURCE,
      author_text: null,
      journal: null,
      doi: null,
      canonical_url: null,
    };
    const result = formatCitation(sparse, 'bibtex', '[1]');
    expect(result).not.toContain('author =');
    expect(result).not.toContain('doi =');
    expect(result).toContain('title =');
  });

  it('ris emits one AU line per author', () => {
    const result = formatCitation(SOURCE, 'ris', '[1]');
    const authorLines = result.split('\n').filter((l) => l.startsWith('AU'));
    expect(authorLines.length).toBe(2);
  });
});

describe('validateCitations', () => {
  it('accepts markers present in the retrieval context', () => {
    const result = validateCitations(['[1]', '[2]'], ['[1]', '[2]', '[3]']);
    expect(result.valid).toEqual(['[1]', '[2]']);
    expect(result.invalid).toEqual([]);
  });

  it('rejects a marker the model invented', () => {
    const result = validateCitations(['[1]', '[9]'], ['[1]', '[2]']);
    expect(result.valid).toEqual(['[1]']);
    expect(result.invalid).toEqual(['[9]']);
  });

  it('deduplicates repeated markers', () => {
    const result = validateCitations(['[1]', '[1]', '[1]'], ['[1]']);
    expect(result.valid).toEqual(['[1]']);
  });
});
