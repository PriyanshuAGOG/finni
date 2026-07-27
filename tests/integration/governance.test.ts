import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import { createManualSource } from '../../src/services/ingestion';
import { archiveSource, restoreSource, changeReviewStatus, permanentlyDeleteSource } from '../../src/services/source';
import { confirmAction, requestConfirmation, guardConfirmation } from '../../src/services/confirmation';
import { getResourceActivity, listAuditEvents } from '../../src/services/audit';
import { withOrg } from '../../src/lib/db';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('governance');
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
});

describe('audit logging', () => {
  it('records a source.created event visible to audit.read', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Audited source',
      text: 'Resistance training performed twice weekly improved grip strength in a cohort of older adults over six months.',
    });

    const activity = await getResourceActivity(org.adminCtx, 'source', source.source_id);
    expect(activity.some((a) => a.action === 'source.created')).toBe(true);
  });

  it('records the acting interface and actor on every write', async () => {
    const { items } = await listAuditEvents(org.adminCtx, { resourceType: 'source', limit: 5 });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].source_interface).toBe('api');
    expect(items[0].actor_type).toBe('user');
  });

  it('a viewer cannot read the organization audit log', async () => {
    await expect(listAuditEvents(org.viewerCtx, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('confirmation-gated archive and restore', () => {
  it('refuses to archive without a confirmation id', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source requiring confirmation',
      text: 'A cross-sectional survey of nurses found widespread variation in reported sleep hygiene practices across shifts.',
    });
    await expect(archiveSource(org.adminCtx, source.source_id)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
  });

  it('archives after a valid confirmation, then can be restored', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source to archive and restore',
      text: 'A retrospective chart review examined prescribing patterns for metformin across three regional hospitals.',
    });

    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'archiveSource',
      resourceType: 'source',
      resourceIds: [source.source_id],
      actionPayload: {},
      humanSummary: 'Archive the test source.',
    });
    await confirmAction(org.adminCtx, confirmation.id, confirmation.required_phrase);

    const archived = await archiveSource(org.adminCtx, source.source_id, confirmation.id);
    expect(archived.status).toBe('archived');

    const restored = await restoreSource(org.adminCtx, source.source_id);
    expect(restored.status).toBe('active');
  });

  it('rejects reusing a confirmation a second time', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source for confirmation reuse test',
      text: 'Farmers-market vegetable subsidy programs were associated with modest increases in self-reported produce intake.',
    });

    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'archiveSource',
      resourceType: 'source',
      resourceIds: [source.source_id],
      actionPayload: {},
      humanSummary: 'Archive the test source.',
    });
    await confirmAction(org.adminCtx, confirmation.id, confirmation.required_phrase);
    await archiveSource(org.adminCtx, source.source_id, confirmation.id);

    await expect(
      withOrg(org.organizationId, (sql) =>
        guardConfirmation(sql, org.adminCtx, {
          actionType: 'archiveSource',
          resourceType: 'source',
          resourceIds: [source.source_id],
          actionPayload: {},
          humanSummary: 'Archive again.',
          confirmationId: confirmation.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
  });

  it('rejects a confirmation phrase that does not match', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source for wrong-phrase test',
      text: 'An observational study linked higher ambient noise exposure at night to elevated morning cortisol.',
    });
    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'archiveSource',
      resourceType: 'source',
      resourceIds: [source.source_id],
      actionPayload: {},
      humanSummary: 'Archive the test source.',
    });
    await expect(confirmAction(org.adminCtx, confirmation.id, 'WRONG PHRASE')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a confirmation issued for a different resource set', async () => {
    const sourceA = await createManualSource(org.adminCtx, {
      title: 'Source A for mismatch test',
      text: 'A pilot trial of a plant-based meal-kit delivery service tracked adherence over eight weeks among working parents.',
    });
    const sourceB = await createManualSource(org.adminCtx, {
      title: 'Source B for mismatch test',
      text: 'Municipal water fluoridation records from twelve districts were compared against pediatric dental caries rates.',
    });

    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'archiveSource',
      resourceType: 'source',
      resourceIds: [sourceA.source_id],
      actionPayload: {},
      humanSummary: 'Archive source A.',
    });
    await confirmAction(org.adminCtx, confirmation.id, confirmation.required_phrase);

    await expect(archiveSource(org.adminCtx, sourceB.source_id, confirmation.id)).rejects.toMatchObject({
      code: 'CONFIRMATION_EXPIRED',
    });
  });
});

describe('permanent deletion', () => {
  it('refuses to permanently delete a source that is not archived', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Active source, cannot be permanently deleted',
      text: 'A workplace stretching program was piloted among warehouse staff to assess its effect on reported musculoskeletal discomfort.',
    });
    await expect(permanentlyDeleteSource(org.adminCtx, source.source_id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a viewer cannot permanently delete anything', async () => {
    await expect(permanentlyDeleteSource(org.viewerCtx, 'nonexistent-id')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('review status transitions', () => {
  it('requires a reason to reject a source', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source for rejection reason test',
      text: 'A wearable step-counter validation study compared consumer devices against a research-grade accelerometer.',
    });
    await expect(
      changeReviewStatus(org.adminCtx, source.source_id, { status: 'rejected' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses an approval while the source is still processing', async () => {
    const source = await createManualSource(org.adminCtx, {
      title: 'Source not yet processed',
      text: 'A qualitative interview study explored barriers to attending follow-up appointments among rural patients.',
      skipEnrichment: false,
    });
    // Freshly ingested with enrichment queued (not completed), so
    // approval must be refused until processing finishes.
    await expect(
      changeReviewStatus(org.adminCtx, source.source_id, { status: 'approved' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
