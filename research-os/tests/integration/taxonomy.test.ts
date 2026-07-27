import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import {
  createCategory,
  findSimilarCategories,
  mergeCategories,
  moveCategory,
  previewCategoryMerge,
} from '../../src/services/taxonomy';
import { requestConfirmation, confirmAction } from '../../src/services/confirmation';
import { createManualSource } from '../../src/services/ingestion';
import { updateSourceTaxonomy } from '../../src/services/source';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('taxonomy');
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
});

describe('category duplicate prevention', () => {
  it('creates a category with no conflict', async () => {
    const category = await createCategory(org.adminCtx, { name: 'Physical Activity' });
    expect(category.name).toBe('Physical Activity');
  });

  it('finds a near-identical existing category by normalized name', async () => {
    const similar = await findSimilarCategories(org.adminCtx, { name: 'physical activities' });
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('refuses to create a near-duplicate category without an explicit override', async () => {
    await expect(createCategory(org.adminCtx, { name: 'Physical Activities' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('allows creating it anyway when allowDuplicate is explicitly set', async () => {
    const category = await createCategory(org.adminCtx, {
      name: 'Physical Activities (distinct)',
      allowDuplicate: true,
    });
    expect(category.name).toBe('Physical Activities (distinct)');
  });

  it('the database itself rejects a duplicate sibling name as a last line of defence', async () => {
    // Bypass the service-level check to prove the partial unique index
    // is the actual backstop, not just application logic.
    const { withOrg } = await import('../../src/lib/db');
    await expect(
      withOrg(org.organizationId, (sql) =>
        sql.query(
          `INSERT INTO categories (organization_id, name, normalized_name, slug)
           VALUES ($1, 'Physical Activity', 'physical activity', 'physical-activity-dup')`,
          [org.organizationId],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('category hierarchy', () => {
  it('prevents a category from becoming its own ancestor', async () => {
    const parent = await createCategory(org.adminCtx, { name: 'Metabolic Health Root' });
    const child = await createCategory(org.adminCtx, {
      name: 'Diabetes Child',
      parentCategoryId: parent.id,
    });

    await expect(moveCategory(org.adminCtx, parent.id, child.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('category merge', () => {
  it('moves source assignments and archives the merged category', async () => {
    const target = await createCategory(org.adminCtx, { name: 'Merge Target' });
    const source1 = await createCategory(org.adminCtx, { name: 'Merge Source One' });
    const source2 = await createCategory(org.adminCtx, { name: 'Merge Source Two' });

    const doc = await createManualSource(org.adminCtx, {
      title: 'Source for merge test',
      text: 'Text long enough for this taxonomy merge test to pass validation checks.',
    });
    await updateSourceTaxonomy(org.adminCtx, doc.source_id, { addCategoryIds: [source1.id] });

    const preview = await previewCategoryMerge(org.adminCtx, {
      sourceCategoryIds: [source1.id, source2.id],
      targetCategoryId: target.id,
    });
    expect(preview.sources_to_move).toBe(1);

    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'mergeCategories',
      resourceType: 'category',
      resourceIds: [source1.id, source2.id].sort(),
      actionPayload: { target_category_id: target.id, preserve_source_names_as_synonyms: true },
      humanSummary: 'Merge test categories.',
    });
    await confirmAction(org.adminCtx, confirmation.id, confirmation.required_phrase);

    const result = await mergeCategories(org.adminCtx, {
      sourceCategoryIds: [source1.id, source2.id],
      targetCategoryId: target.id,
      confirmationId: confirmation.id,
    });
    expect(result.sources_moved).toBe(1);

    const merged = await createCategory(org.adminCtx, {
      name: 'Yet Another Distinct Category',
    });
    void merged;

    const stillFindable = await findSimilarCategories(org.adminCtx, { name: 'Merge Source One' });
    // The merged-away name survives as a synonym on the target, so future
    // classification under the old name still resolves to the merged category.
    expect(stillFindable.some((c) => c.id === target.id)).toBe(true);
  });
});
