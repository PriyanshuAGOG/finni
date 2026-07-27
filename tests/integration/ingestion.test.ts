import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import { createManualSource, ingestUrlsBatch } from '../../src/services/ingestion';
import { ApiError } from '../../src/lib/errors';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('ingestion');
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
});

describe('source creation', () => {
  it('creates a source that is unreviewed by default', async () => {
    const result = await createManualSource(org.adminCtx, {
      title: 'A new source about walking',
      text: 'Walking after meals may help control blood sugar levels in some adults.',
    });
    expect(result.created).toBe(true);
    expect(result.review_status).toBe('needs_review');
  });

  it('rejects an empty title', async () => {
    await expect(
      createManualSource(org.adminCtx, { title: '', text: 'Some text here that is long enough.' }),
    ).rejects.toThrow();
  });

  it('rejects a viewer attempting to create a source', async () => {
    await expect(
      createManualSource(org.viewerCtx, { title: 'Viewer attempt', text: 'Text long enough to pass.' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('duplicate detection', () => {
  it('detects an exact content duplicate by hash and refuses to create a second copy', async () => {
    const text = 'This exact passage will be duplicated verbatim in a second source record for testing.';
    const first = await createManualSource(org.adminCtx, { title: 'Duplicate source one', text });

    // The default duplicate behavior is "warn": it refuses the write and
    // reports what already matches, rather than silently creating a copy.
    try {
      await createManualSource(org.adminCtx, { title: 'Duplicate source two (different title)', text });
      expect.unreachable('should have thrown DUPLICATE_SOURCE');
    } catch (err) {
      expect(err).toMatchObject({ code: 'DUPLICATE_SOURCE' });
      const duplicates = (err as { details: { duplicates: Array<{ source_id: string; kind: string }> } })
        .details.duplicates;
      expect(duplicates[0].kind).toBe('exact_duplicate');
      expect(duplicates[0].source_id).toBe(first.source_id);
    }
  });

  it('does not flag genuinely different content as a duplicate', async () => {
    const a = await createManualSource(org.adminCtx, {
      title: 'Unique source A',
      text: 'Resistance training improves insulin sensitivity in adults with prediabetes over 24 weeks.',
    });
    const b = await createManualSource(org.adminCtx, {
      title: 'Unique source B',
      text: 'Sleep duration is associated with incident type 2 diabetes risk in a prospective cohort study.',
    });
    expect(a.duplicate_status).toBe('none');
    expect(b.duplicate_status).toBe('none');
  });
});

describe('batch ingestion', () => {
  it('rejects a batch larger than the configured maximum', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://example.com/article-${i}`);
    await expect(ingestUrlsBatch(org.adminCtx, { urls })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects an empty batch', async () => {
    await expect(ingestUrlsBatch(org.adminCtx, { urls: [] })).rejects.toThrow();
  });
});

describe('URL rejection for unreachable hosts', () => {
  it('reports a clear error rather than hanging when a host cannot be fetched', async () => {
    const { ingestUrl } = await import('../../src/services/ingestion');
    await expect(
      ingestUrl(org.adminCtx, { url: 'https://this-host-does-not-exist-nirogbhoomi-test.invalid/article' }),
    ).rejects.toBeInstanceOf(ApiError);
  }, 30000);
});
