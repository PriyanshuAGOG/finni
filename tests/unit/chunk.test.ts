import { describe, expect, it } from 'vitest';
import { chunkDocument, chunkLocator } from '../../src/extraction/chunk';

const SAMPLE = `Abstract

We conducted a randomized controlled trial to evaluate whether post-meal walking reduces postprandial glucose in adults with type 2 diabetes. Two hundred fifty participants were enrolled across three urban clinics.

Methods

Participants were randomized 1:1 to a 15-minute post-meal walking intervention or usual care for 12 weeks. The primary outcome was postprandial glucose measured by continuous glucose monitoring.

Results

Post-meal walking significantly reduced postprandial glucose excursions compared to control (p < 0.01). The effect was most pronounced after the largest meal of the day.

Limitations

The study was conducted over 12 weeks only, so longer-term effects on HbA1c remain unknown.`;

describe('chunkDocument', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkDocument('')).toEqual([]);
  });

  it('splits a structured document into multiple chunks', () => {
    const chunks = chunkDocument(SAMPLE, { targetTokens: 40, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('assigns non-overlapping, increasing chunk indexes', () => {
    const chunks = chunkDocument(SAMPLE, { targetTokens: 40, overlapTokens: 10 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('records a heading path for chunks under a section', () => {
    const chunks = chunkDocument(SAMPLE, { targetTokens: 200 });
    const methodsChunk = chunks.find((c) => c.text.includes('Participants were randomized'));
    expect(methodsChunk?.headingPath).toContain('Methods');
  });

  it('keeps every chunk within a reasonable size of the target', () => {
    const chunks = chunkDocument(SAMPLE, { targetTokens: 30, overlapTokens: 5 });
    for (const chunk of chunks) {
      // Generous upper bound: a chunk should not balloon far past target.
      expect(chunk.tokenCount).toBeLessThan(30 * 4);
    }
  });

  it('start and end offsets point back into the normalized text', () => {
    const chunks = chunkDocument(SAMPLE, { targetTokens: 200 });
    for (const chunk of chunks) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
    }
  });

  it('assigns page numbers from supplied page offsets', () => {
    const text = 'Page one content here that is reasonably long for a paragraph.\n\nPage two content here that is also long enough.';
    const secondBlockStart = text.indexOf('Page two');
    const pageOffsets = [
      { page: 1, start: 0, end: secondBlockStart },
      { page: 2, start: secondBlockStart, end: text.length },
    ];
    const chunks = chunkDocument(text, { targetTokens: 5, overlapTokens: 0, pageOffsets });
    expect(chunks.some((c) => c.pageNumber === 1)).toBe(true);
    expect(chunks.some((c) => c.pageNumber === 2)).toBe(true);
  });
});

describe('chunkLocator', () => {
  it('prefers a page number when available', () => {
    expect(chunkLocator({ pageNumber: 4, headingPath: 'Methods' })).toContain('p. 4');
  });

  it('falls back to a passage index when there is no page or heading', () => {
    expect(chunkLocator({ chunkIndex: 2 })).toContain('passage 3');
  });
});
