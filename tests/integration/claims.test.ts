import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestOrg, destroyTestOrg, type TestOrg } from './fixtures';
import { createManualSource } from '../../src/services/ingestion';
import {
  addClaimEvidence,
  createClaim,
  getClaim,
  removeClaimEvidence,
  reviewClaim,
  updateClaim,
} from '../../src/services/claim';
import { confirmAction, requestConfirmation } from '../../src/services/confirmation';

let org: TestOrg;
let sourceId: string;
let contradictingSourceId: string;

beforeAll(async () => {
  org = await createTestOrg('claims');
  const source = await createManualSource(org.adminCtx, {
    title: 'Supporting source for claim tests',
    text: 'A randomized trial found that the intervention reduced the outcome measure significantly.',
  });
  sourceId = source.source_id;
  const other = await createManualSource(org.adminCtx, {
    title: 'Contradicting source for claim tests',
    text: 'A separate trial found no significant effect of the same intervention on the outcome measure.',
  });
  contradictingSourceId = other.source_id;
});

afterAll(async () => {
  await destroyTestOrg(org.organizationId);
});

describe('claim evidence-status derivation', () => {
  it('starts unreviewed with no evidence', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'The intervention significantly reduces the outcome measure.',
    });
    expect(claim.evidence_status).toBe('unreviewed');
  });

  it('becomes likely_supported with one supporting source', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'A single-source claim about the intervention effect on the outcome.',
      sourceEvidence: [{ sourceId, relationship: 'supports' }],
    });
    expect(claim.evidence_status).toBe('likely_supported');
  });

  it('becomes contested when contradicting evidence outweighs supporting evidence', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'A contested claim about the intervention effect that will gain conflicting evidence.',
      sourceEvidence: [{ sourceId, relationship: 'supports' }],
    });
    const claimId = claim.id as string;

    await addClaimEvidence(org.adminCtx, claimId, {
      sourceId: contradictingSourceId,
      relationship: 'contradicts',
    });
    await addClaimEvidence(org.adminCtx, claimId, {
      sourceId: contradictingSourceId,
      relationship: 'contradicts',
      locator: 'second passage',
    });

    const updated = await getClaim(org.adminCtx, claimId);
    expect(updated.evidence_status).toBe('contested');
  });

  it('does not overwrite a human review decision when new evidence is added', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'A reviewed claim that should not be silently overridden by new evidence.',
      sourceEvidence: [{ sourceId, relationship: 'supports' }],
    });
    const claimId = claim.id as string;

    await reviewClaim(org.adminCtx, claimId, {
      evidenceStatus: 'supported',
      clinicalReviewStatus: 'reviewed',
      rationale: 'Reviewed and confirmed by a clinician for this test.',
    });

    await addClaimEvidence(org.adminCtx, claimId, {
      sourceId: contradictingSourceId,
      relationship: 'contradicts',
    });

    const after = await getClaim(org.adminCtx, claimId);
    // The reviewer's status stands; the claim is flagged for re-review
    // rather than having its status silently changed underneath them.
    expect(after.evidence_status).toBe('supported');
    expect(after.clinical_review_status).toBe('needs_re_review');
  });
});

describe('claim edit protections', () => {
  it('sends an approved claim back to re-review when its text changes', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'A claim that will be approved and then edited in this test.',
      sourceEvidence: [{ sourceId, relationship: 'supports' }],
    });
    const claimId = claim.id as string;

    await reviewClaim(org.adminCtx, claimId, {
      evidenceStatus: 'supported',
      clinicalReviewStatus: 'reviewed',
      rationale: 'Approved for this test.',
    });

    // Editing an approved claim is high risk and requires the same
    // server-issued confirmation as any other high-risk write.
    const update = { canonical_text: 'A revised claim text after approval.' };
    const confirmation = await requestConfirmation(org.adminCtx, {
      actionType: 'updateClaim',
      resourceType: 'claim',
      resourceIds: [claimId],
      actionPayload: update,
      humanSummary: 'Edit the approved claim text.',
    });
    await confirmAction(org.adminCtx, confirmation.id, confirmation.required_phrase);

    await updateClaim(org.adminCtx, claimId, update, { confirmationId: confirmation.id });

    const after = await getClaim(org.adminCtx, claimId);
    expect(after.clinical_review_status).toBe('needs_re_review');
  });

  it('rejects an unknown field on update', async () => {
    const claim = await createClaim(org.adminCtx, { canonicalText: 'A claim used to test field rejection.' });
    await expect(
      updateClaim(org.adminCtx, claim.id as string, { evidence_status: 'supported' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('claim archive and restore', () => {
  it('requires a rationale to review a claim', async () => {
    const claim = await createClaim(org.adminCtx, { canonicalText: 'A claim used to test the rationale requirement.' });
    await expect(
      reviewClaim(org.adminCtx, claim.id as string, { evidenceStatus: 'supported', rationale: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('removing evidence from an unreviewed claim does not require confirmation', async () => {
    const claim = await createClaim(org.adminCtx, {
      canonicalText: 'A claim whose evidence will be removed without confirmation in this test.',
      sourceEvidence: [{ sourceId, relationship: 'supports' }],
    });
    const claimId = claim.id as string;
    const full = await getClaim(org.adminCtx, claimId);
    const evidenceId = (full.supporting_evidence as Array<{ evidence_id: string }>)[0].evidence_id;

    await expect(removeClaimEvidence(org.adminCtx, claimId, evidenceId)).resolves.toBeDefined();
  });
});
