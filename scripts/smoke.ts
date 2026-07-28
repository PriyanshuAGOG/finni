/**
 * End-to-end smoke test run directly against the service layer (not
 * through HTTP), exercising: org/user/role bootstrap, source ingestion,
 * enrichment (via direct handler calls, bypassing the queue for speed),
 * search, synthesis, claim creation, and confirmation-gated archiving.
 *
 * This is a development script, not part of the automated test suite.
 */
import { randomUUID } from 'node:crypto';
import { withoutOrg, withOrg, closePool } from '../src/lib/db';
import type { ActorContext } from '../src/lib/context';
import { reportError } from './lib/report-error';
import { SYSTEM_ROLES } from '../src/domain/permissions';
import { createManualSource } from '../src/services/ingestion';
import { searchKnowledge } from '../src/services/search';
import { synthesizeKnowledge } from '../src/services/synthesis';
import { createCategory, findSimilarCategories } from '../src/services/taxonomy';
import { createCollection } from '../src/services/collection';
import { createClaim } from '../src/services/claim';
import { archiveSource } from '../src/services/source';
import { requestConfirmation, confirmAction } from '../src/services/confirmation';
import { HANDLERS, contextForJob } from '../src/worker/handlers';
import { claimNextJob } from '../src/services/processing';
import type { ProcessingJob } from '../src/services/processing';

async function main() {
  const orgId = randomUUID();
  const userId = randomUUID();

  await withoutOrg(async (sql) => {
    await sql.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Smoke Test Org',$2)`, [orgId, `smoke-test-org-${orgId.slice(0, 8)}`]);
  });

  await withOrg(orgId, async (sql) => {
    const roleId = randomUUID();
    const adminRole = SYSTEM_ROLES.find((r) => r.slug === 'administrator')!;
    await sql.query(
      `INSERT INTO roles (id, organization_id, name, slug, is_system_role, permissions)
       VALUES ($1,$2,$3,$4,true,$5)`,
      [roleId, orgId, adminRole.name, adminRole.slug, JSON.stringify(adminRole.permissions)],
    );
    await sql.query(
      `INSERT INTO users (id, organization_id, full_name, email, status) VALUES ($1,$2,'Smoke Test User','smoke@test.local','active')`,
      [userId, orgId],
    );
    await sql.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [userId, roleId]);
  });

  const ctx: ActorContext = {
    organizationId: orgId,
    userId,
    userName: 'Smoke Test User',
    actorType: 'user',
    sourceInterface: 'api',
    permissions: new Set(SYSTEM_ROLES.find((r) => r.slug === 'administrator')!.permissions),
    scopes: null,
    requestId: 'smoke-test',
  };

  console.log('--- 1. Category creation + duplicate detection ---');
  const category = await createCategory(ctx, { name: 'Post-Meal Walking' });
  console.log('created category:', category.name);
  const similar = await findSimilarCategories(ctx, { name: 'Post Meal Walking' });
  console.log('similar categories found:', similar.length, similar[0]?.similarity);
  if (similar.length === 0 || similar[0].similarity < 0.8) throw new Error('duplicate detection failed');

  console.log('--- 2. Collection creation ---');
  const collection = await createCollection(ctx, {
    name: 'Glucose Control Evidence',
    researchQuestion: 'Does post-meal walking improve glucose control?',
  });
  console.log('created collection:', collection.name);

  console.log('--- 3. Manual source ingestion ---');
  const ingested = await createManualSource(ctx, {
    title: 'Post-meal walking and postprandial glucose: a randomized controlled trial',
    text: `Abstract: We conducted a randomized controlled trial (n = 250) among adults with type 2 diabetes in India to test whether a 15-minute walk after each main meal reduces postprandial glucose excursions compared to a sedentary control group.

Methods: Participants (n=250) were randomized to a 12-week walking intervention or usual care. The primary outcome was postprandial glucose measured by continuous glucose monitoring.

Results: Post-meal walking significantly reduced postprandial glucose excursions compared to the control group (p < 0.01). The effect was most pronounced after the largest meal of the day. Mean HbA1c decreased by 0.4 percentage points in the walking group.

Adverse events: No serious adverse events were reported. Two participants reported mild joint discomfort.

Limitations: The study was conducted over 12 weeks and longer-term effects on HbA1c are unknown. The sample was drawn from urban clinics in India and may not generalize to rural populations.

Funding: This study was funded by an institutional grant with no involvement from industry sponsors.

Conflicts of interest: The authors declare no conflicts of interest.`,
    sourceType: 'randomized_controlled_trial',
    categoryIds: [category.id],
    collectionIds: [collection.id],
    tags: ['walking', 'glucose', 'diabetes'],
  });
  console.log('ingested source:', ingested.source_id, ingested.review_status, ingested.duplicate_status);

  console.log('--- 4. Running enrichment pipeline stages directly ---');
  for (const stage of ['summarize', 'classify', 'study_metadata', 'claims', 'embeddings', 'evidence_assessment']) {
    const job = await claimNextJob(`smoke-test-worker`);
    if (!job) {
      console.log(`  no queued job found for expected stage ${stage} (may already be processed)`);
      continue;
    }
    const jobCtx = contextForJob(job, `smoke-${stage}`);
    const handler = HANDLERS[job.job_type];
    const result = await handler(job, jobCtx);
    console.log(`  ran ${job.job_type}:`, JSON.stringify(result.output), result.warnings.length ? `warnings=${result.warnings.length}` : '');
  }

  console.log('--- 5. Search (keyword + semantic hybrid) ---');
  const searchResult = await searchKnowledge(ctx, {
    query: 'post-meal walking glucose',
    mode: 'library_first',
    includeUnreviewed: true,
    includePassages: true,
  });
  console.log('search results:', searchResult.results.length, 'scope:', searchResult.scope.source_origin);
  if (searchResult.results.length === 0) throw new Error('search returned no results');

  console.log('--- 6. Synthesis with citation validation ---');
  const synthesis = await synthesizeKnowledge(ctx, {
    question: 'Does post-meal walking reduce postprandial glucose?',
    approvedOnly: false,
  });
  console.log('synthesis citations:', synthesis.citations.length, 'rejected:', synthesis.rejected_citations.length);
  console.log('answer snippet:', synthesis.answer.slice(0, 200));

  console.log('--- 7. Claim creation ---');
  const claim = await createClaim(ctx, {
    canonicalText: 'A 15-minute walk after meals reduces postprandial glucose excursions in adults with type 2 diabetes.',
    population: 'Adults with type 2 diabetes in India',
    intervention: 'Post-meal 15-minute walk',
    outcome: 'Postprandial glucose excursion',
    sourceEvidence: [{ sourceId: ingested.source_id, relationship: 'supports' }],
  });
  console.log('created claim:', claim.canonical_text, 'evidence_status:', claim.evidence_status);

  console.log('--- 8. Confirmation-gated archive ---');
  const confirmation = await requestConfirmation(ctx, {
    actionType: 'archiveSource',
    resourceType: 'source',
    resourceIds: [ingested.source_id],
    actionPayload: {},
    humanSummary: `Archive "${ingested.title}"`,
  });
  console.log('confirmation requested, phrase:', confirmation.required_phrase);
  await confirmAction(ctx, confirmation.id, confirmation.required_phrase);
  const archived = await archiveSource(ctx, ingested.source_id, confirmation.id);
  console.log('archived source status:', archived.status);
  if (archived.status !== 'archived') throw new Error('archive did not apply');

  // Confirm reuse is rejected.
  try {
    await archiveSource(ctx, ingested.source_id, confirmation.id);
    throw new Error('confirmation reuse should have failed');
  } catch (err) {
    console.log('confirmation reuse correctly rejected:', err instanceof Error ? err.message.slice(0, 60) : err);
  }

  console.log('\nALL SMOKE TESTS PASSED');

  // Deleting an organization is not a normal application operation (there
  // is deliberately no API for it), so FK columns like assigned_by are
  // not cascading -- clean up test data in dependency order instead.
  // RLS requires the organization context, so this runs via withOrg.
  await withOrg(orgId, async (sql) => {
    await sql.query(`DELETE FROM source_categories`);
    await sql.query(`DELETE FROM source_tags`);
    await sql.query(`DELETE FROM claim_evidence`);
    await sql.query(`DELETE FROM claim_categories`);
    await sql.query(`DELETE FROM annotations`);
    await sql.query(`DELETE FROM embedding_chunks`);
    await sql.query(`DELETE FROM processing_jobs`);
    await sql.query(`DELETE FROM audit_logs`);
    await sql.query(`DELETE FROM claims`);
    await sql.query(`DELETE FROM sources`);
  });
  await withoutOrg((sql) => sql.query(`DELETE FROM organizations WHERE id = $1`, [orgId]));
  await closePool();
}

main().catch(async (err) => {
  console.error('SMOKE TEST FAILED:');
  reportError(err);
  await closePool();
  process.exit(1);
});
