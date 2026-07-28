/**
 * Retrieval evaluation suite.
 *
 * Runs a small, hand-labelled set of queries against searchKnowledge and
 * synthesizeKnowledge and reports recall, precision, citation
 * correctness, the unsupported-statement rate, and whether the
 * approved-only policy actually held. This is a development/CI signal,
 * not a unit test: retrieval quality is a spectrum, not a pass/fail, so
 * this prints a report rather than asserting hard thresholds.
 *
 * Requires the seed data (`npm run db:seed`) to have been run first,
 * since the eval cases are written against it.
 */
import { withoutOrg, withOrg, closePool } from '../src/lib/db';
import type { ActorContext } from '../src/lib/context';
import { SYSTEM_ROLES } from '../src/domain/permissions';
import { reportError } from './lib/report-error';
import { searchKnowledge } from '../src/services/search';
import { synthesizeKnowledge } from '../src/services/synthesis';

interface EvalCase {
  name: string;
  query: string;
  approvedOnly: boolean;
  /** Substrings expected to appear in a relevant result's title. */
  expectedRelevantTitleContains: string[];
  /** Substrings that must NOT appear among the top results (distractors). */
  expectedIrrelevantTitleContains: string[];
  /** For synthesis cases: whether a contradiction should be surfaced. */
  expectContradiction?: boolean;
}

const CASES: EvalCase[] = [
  {
    name: 'post-meal walking (approved only)',
    query: 'Does walking after meals reduce blood glucose?',
    approvedOnly: true,
    expectedRelevantTitleContains: ['Post-meal walking', 'Timing of physical activity'],
    expectedIrrelevantTitleContains: ['5 micronutrients'],
  },
  {
    name: 'resistance training and insulin sensitivity',
    query: 'resistance training insulin sensitivity prediabetes',
    approvedOnly: true,
    expectedRelevantTitleContains: ['Resistance training'],
    expectedIrrelevantTitleContains: ['Acupressure'],
  },
  {
    name: 'sleep and diabetes risk',
    query: 'sleep duration diabetes risk',
    approvedOnly: true,
    expectedRelevantTitleContains: ['Sleep duration'],
    expectedIrrelevantTitleContains: ['Naturopathic'],
  },
  {
    name: 'mindfulness and stress evidence tension',
    query: 'mindfulness stress reduction HbA1c',
    approvedOnly: false,
    expectedRelevantTitleContains: ['Mindfulness meditation', 'cortisol'],
    expectedIrrelevantTitleContains: [],
    expectContradiction: false,
  },
  {
    name: 'unapproved naturopathy claim should not appear when approved-only',
    query: 'magnesium supplement blood sugar',
    approvedOnly: true,
    expectedRelevantTitleContains: [],
    expectedIrrelevantTitleContains: ['micronutrients every diabetic'],
  },
];

async function getEvalContext(): Promise<ActorContext> {
  const org = await withoutOrg((sql) =>
    sql.one<{ id: string }>(`SELECT id FROM organizations WHERE slug = 'nirog-bhoomi'`),
  );
  if (!org) {
    throw new Error('Seed data not found. Run `npm run db:seed` first.');
  }

  const user = await withOrg(org.id, (sql) =>
    sql.one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE email = 'admin@nirogbhoomi.dev'`,
    ),
  );
  if (!user) throw new Error('Seed admin user not found.');

  const permissions = new Set(SYSTEM_ROLES.find((r) => r.slug === 'administrator')!.permissions);
  return {
    organizationId: org.id,
    userId: user.id,
    userName: user.full_name,
    actorType: 'user',
    sourceInterface: 'api',
    permissions,
    scopes: null,
    requestId: 'eval-retrieval',
  };
}

interface CaseResult {
  name: string;
  recall: number;
  precision: number;
  approvedOnlyHeld: boolean;
  citationsAllValid: boolean;
  citationCount: number;
  unsupportedStatementSignal: boolean;
}

async function runCase(ctx: ActorContext, testCase: EvalCase): Promise<CaseResult> {
  const search = await searchKnowledge(ctx, {
    query: testCase.query,
    entityTypes: ['sources'],
    filters: testCase.approvedOnly ? { reviewStatus: ['approved', 'approved_with_conditions'] } : {},
    includeUnreviewed: !testCase.approvedOnly,
    limit: 10,
  });

  const titles = search.results.map((r) => r.title);
  const relevantFound = testCase.expectedRelevantTitleContains.filter((needle) =>
    titles.some((t) => t.includes(needle)),
  );
  const irrelevantLeaked = testCase.expectedIrrelevantTitleContains.filter((needle) =>
    titles.some((t) => t.includes(needle)),
  );

  const recall =
    testCase.expectedRelevantTitleContains.length === 0
      ? 1
      : relevantFound.length / testCase.expectedRelevantTitleContains.length;
  const precision = titles.length === 0 ? 1 : 1 - irrelevantLeaked.length / titles.length;

  const approvedOnlyHeld =
    !testCase.approvedOnly || search.results.every((r) => r.origin === 'internal_approved');

  const synthesis = await synthesizeKnowledge(ctx, {
    question: testCase.query,
    approvedOnly: testCase.approvedOnly,
  });

  // Every citation the synthesis returns must point at a source id that
  // was actually retrieved -- proof the citation-verification step in
  // synthesizeKnowledge is doing its job, not just trusting the model.
  const retrievedIds = new Set(search.results.map((r) => r.id));
  const citationsAllValid = synthesis.citations.every((c) => retrievedIds.has(c.source_id));

  return {
    name: testCase.name,
    recall,
    precision,
    approvedOnlyHeld,
    citationsAllValid,
    citationCount: synthesis.citations.length,
    unsupportedStatementSignal: synthesis.rejected_citations.length > 0,
  };
}

async function main() {
  const ctx = await getEvalContext();
  const results: CaseResult[] = [];

  for (const testCase of CASES) {
    results.push(await runCase(ctx, testCase));
  }

  console.log('\nRetrieval Evaluation Report');
  console.log('='.repeat(70));
  for (const r of results) {
    console.log(`\n${r.name}`);
    console.log(`  recall:              ${(r.recall * 100).toFixed(0)}%`);
    console.log(`  precision:           ${(r.precision * 100).toFixed(0)}%`);
    console.log(`  approved-only held:  ${r.approvedOnlyHeld ? 'yes' : 'NO -- POLICY VIOLATION'}`);
    console.log(`  citations valid:     ${r.citationsAllValid ? 'yes' : 'NO -- FABRICATED CITATION'}`);
    console.log(`  citation count:      ${r.citationCount}`);
    if (r.unsupportedStatementSignal) {
      console.log(`  note: the model produced at least one citation marker not in context (stripped before output).`);
    }
  }

  const meanRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const meanPrecision = results.reduce((s, r) => s + r.precision, 0) / results.length;
  const allCitationsValid = results.every((r) => r.citationsAllValid);
  const allPolicyHeld = results.every((r) => r.approvedOnlyHeld);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Mean recall:                ${(meanRecall * 100).toFixed(0)}%`);
  console.log(`Mean precision:             ${(meanPrecision * 100).toFixed(0)}%`);
  console.log(`Citation correctness:       ${allCitationsValid ? 'PASS' : 'FAIL'}`);
  console.log(`Approved-only adherence:    ${allPolicyHeld ? 'PASS' : 'FAIL'}`);
  console.log(
    `\nNote: recall/precision depend on the deterministic AI provider's lexical\n` +
      `matching when AI_PROVIDER=deterministic. Configure a real provider for a\n` +
      `production-representative quality signal.`,
  );

  await closePool();

  if (!allCitationsValid || !allPolicyHeld) process.exit(1);
}

main().catch(async (err) => {
  reportError(err);
  await closePool();
  process.exit(1);
});
