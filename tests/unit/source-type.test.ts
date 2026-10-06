import { describe, expect, it } from 'vitest';
import { isSourceType, normalizeSourceType, SOURCE_TYPES } from '../../src/domain/source-type';

describe('normalizeSourceType', () => {
  it('passes through an exact enum value unchanged', () => {
    for (const type of SOURCE_TYPES) {
      expect(normalizeSourceType(type)).toBe(type);
    }
  });

  it('maps the common free-form guesses that are not themselves enum members', () => {
    expect(normalizeSourceType('article')).toBe('web_article');
    expect(normalizeSourceType('Article')).toBe('web_article');
    expect(normalizeSourceType('news article')).toBe('web_article');
    expect(normalizeSourceType('blog post')).toBe('web_article');
    expect(normalizeSourceType('paper')).toBe('research_paper');
    expect(normalizeSourceType('study')).toBe('research_paper');
    expect(normalizeSourceType('pdf')).toBe('uploaded_pdf');
    expect(normalizeSourceType('clinical trial')).toBe('randomized_controlled_trial');
    expect(normalizeSourceType('tweet')).toBe('social_post');
  });

  it('is forgiving of case, hyphens and whitespace', () => {
    expect(normalizeSourceType('Research Paper')).toBe('research_paper');
    expect(normalizeSourceType('research-paper')).toBe('research_paper');
    expect(normalizeSourceType('  web_article  ')).toBe('web_article');
  });

  it('falls back to the default rather than ever throwing on nonsense input', () => {
    expect(normalizeSourceType('completely-unrecognized-type')).toBe('other');
    expect(normalizeSourceType(null)).toBe('other');
    expect(normalizeSourceType(undefined)).toBe('other');
    expect(normalizeSourceType('')).toBe('other');
  });

  it('accepts a caller-supplied fallback instead of the default', () => {
    expect(normalizeSourceType('nonsense', 'manual_note')).toBe('manual_note');
  });
});

describe('isSourceType', () => {
  it('recognizes real enum members and rejects everything else', () => {
    expect(isSourceType('web_article')).toBe(true);
    expect(isSourceType('article')).toBe(false);
  });
});
