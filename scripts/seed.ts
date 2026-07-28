/**
 * Development seed data.
 *
 * Everything created here is clearly synthetic and is written to say so
 * in-record where it matters (source titles, brief titles). None of it
 * should be treated as genuine medical evidence -- it exists to exercise
 * every part of the UI and API: multiple review states, a duplicate pair,
 * a superseded source, a retraction warning, a disputed claim, varied
 * processing states, and enough volume that list/filter screens are not
 * empty.
 *
 * Idempotent: re-running it clears prior seed data (identified by the
 * fixed organization slug) and rebuilds it from scratch.
 */
import { randomUUID } from 'node:crypto';
import { withOrg, withoutOrg, closePool } from '../src/lib/db';
import type { ActorContext } from '../src/lib/context';
import { reportError } from './lib/report-error';
import { SYSTEM_ROLES } from '../src/domain/permissions';
import { hashPassword } from '../src/lib/crypto';
import { createCategory } from '../src/services/taxonomy';
import { createCollection, addSourcesToCollection } from '../src/services/collection';
import { createManualSource } from '../src/services/ingestion';
import { createClaim } from '../src/services/claim';
import { createAnnotation } from '../src/services/annotation';
import { createBrief, generateBrief } from '../src/services/brief';
import { changeReviewStatus } from '../src/services/source';
import { HANDLERS, contextForJob } from '../src/worker/handlers';
import { claimNextJob, enqueueStandalone } from '../src/services/processing';

const ORG_SLUG = 'nirog-bhoomi';

async function main() {
  console.log('Seeding Nirog Bhoomi Research OS with sample data...\n');

  await purgeExisting();

  const orgId = await createOrganization();
  const users = await createUsersAndRoles(orgId);

  const asAdmin = contextFor(orgId, users.admin.id, 'Administrator');
  const asResearcher = contextFor(orgId, users.researcher.id, 'Researcher A. Kumar');
  const asClinical = contextFor(orgId, users.clinical.id, 'Dr. Clinical Reviewer');
  const asContent = contextFor(orgId, users.content.id, 'Content Team Member');

  console.log('Creating taxonomy...');
  const categories = await createTaxonomy(asAdmin);

  console.log('Creating tags...');
  await createTags(orgId);

  console.log('Creating sources...');
  const sources = await createSources(asResearcher, categories);

  console.log('Running enrichment pipeline on all sources...');
  await runAllQueuedJobs();

  console.log('Setting review states...');
  await applyReviewStates(asClinical, sources);

  console.log('Creating duplicate, superseded and retraction scenarios...');
  await createSpecialScenarios(asResearcher, sources);

  console.log('Creating collections...');
  const collections = await createCollections(asResearcher, sources);
  void collections;

  console.log('Creating claims and evidence...');
  await createClaimsAndEvidence(asClinical, sources);

  console.log('Creating annotations...');
  await createAnnotations(asContent, asClinical, sources);

  console.log('Creating research briefs...');
  await createBriefs(asResearcher, sources, collections);

  console.log('Seeding processing job variety...');
  await seedProcessingJobStates(asAdmin, sources);

  console.log('\nSeed complete.');
  console.log(`Organization slug: ${ORG_SLUG}`);
  console.log('Sample sign-in accounts (password: "DevPassword123!"):');
  for (const [role, user] of Object.entries(users)) {
    console.log(`  ${role.padEnd(12)} ${user.email}`);
  }

  await closePool();
}

// ---------------------------------------------------------------------

async function purgeExisting(): Promise<void> {
  const existing = await withoutOrg((sql) =>
    sql.one<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [ORG_SLUG]),
  );
  if (!existing) return;

  console.log('Removing previous seed data...');
  await withOrg(existing.id, async (sql) => {
    for (const table of [
      'generated_content_citations', 'generated_content', 'brief_versions', 'brief_sources',
      'research_briefs', 'research_candidates', 'research_jobs', 'processing_jobs',
      'embedding_chunks', 'annotations', 'claim_evidence', 'claim_categories',
      'claim_relations', 'claims', 'collection_sources', 'smart_collection_rules',
      'collections', 'source_categories', 'source_tags', 'source_contributors',
      'source_versions', 'evidence_assessments', 'study_metadata', 'sources',
      'categories', 'tags', 'audit_logs', 'action_confirmations', 'ai_usage_events',
      'search_events', 'user_roles', 'user_permission_overrides', 'api_clients',
    ]) {
      await sql.query(`DELETE FROM ${table}`);
    }
    await sql.query(`DELETE FROM users`);
    await sql.query(`DELETE FROM roles`);
  });
  await withoutOrg((sql) => sql.query(`DELETE FROM organizations WHERE id = $1`, [existing.id]));
}

async function createOrganization(): Promise<string> {
  const id = randomUUID();
  await withoutOrg((sql) =>
    sql.query(
      `INSERT INTO organizations (id, name, slug, timezone, default_language, settings)
       VALUES ($1,'Nirog Bhoomi','${ORG_SLUG}','Asia/Kolkata','en',$2)`,
      [id, JSON.stringify({ product_name: 'Nirog Bhoomi Research OS', allow_ai_category_creation: false })],
    ),
  );
  return id;
}

interface SeedUser {
  id: string;
  email: string;
}

async function createUsersAndRoles(orgId: string): Promise<Record<string, SeedUser>> {
  const roleIds = new Map<string, string>();

  await withOrg(orgId, async (sql) => {
    for (const role of SYSTEM_ROLES) {
      const id = randomUUID();
      roleIds.set(role.slug, id);
      await sql.query(
        `INSERT INTO roles (id, organization_id, name, slug, description, is_system_role, permissions)
         VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [id, orgId, role.name, role.slug, role.description, JSON.stringify(role.permissions)],
      );
    }
  });

  const passwordHash = hashPassword('DevPassword123!');

  const roster: Array<{ key: string; name: string; email: string; jobTitle: string; roleSlug: string }> = [
    { key: 'admin', name: 'Asha Administrator', email: 'admin@nirogbhoomi.dev', jobTitle: 'Platform Administrator', roleSlug: 'administrator' },
    { key: 'manager', name: 'Meera Manager', email: 'research.manager@nirogbhoomi.dev', jobTitle: 'Research Manager', roleSlug: 'research_manager' },
    { key: 'researcher', name: 'Rohan Researcher', email: 'researcher@nirogbhoomi.dev', jobTitle: 'Researcher', roleSlug: 'researcher' },
    { key: 'clinical', name: 'Dr. Chitra Nair', email: 'clinical.reviewer@nirogbhoomi.dev', jobTitle: 'Clinical Reviewer', roleSlug: 'clinical_reviewer' },
    { key: 'content', name: 'Cyrus Content', email: 'content@nirogbhoomi.dev', jobTitle: 'Content Strategist', roleSlug: 'content_team' },
    { key: 'viewer', name: 'Vikram Viewer', email: 'viewer@nirogbhoomi.dev', jobTitle: 'Operations', roleSlug: 'viewer' },
  ];

  const users: Record<string, SeedUser> = {};

  await withOrg(orgId, async (sql) => {
    for (const person of roster) {
      const id = randomUUID();
      await sql.query(
        `INSERT INTO users (id, organization_id, full_name, email, password_hash, job_title, status, last_active_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active', now())`,
        [id, orgId, person.name, person.email, passwordHash, person.jobTitle],
      );
      await sql.query(`INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$1)`, [
        id,
        roleIds.get(person.roleSlug),
      ]);
      users[person.key] = { id, email: person.email };
    }
  });

  return users;
}

function contextFor(organizationId: string, userId: string, userName: string): ActorContext {
  // Permissions are re-resolved per call in the real API; the seed script
  // grants full permissions per actor role by pulling from SYSTEM_ROLES
  // via a lookup at each call site would be more accurate, but for
  // seeding speed we grant broad permissions and rely on the workflow
  // functions themselves to behave correctly regardless of over-grant.
  const allPermissions = new Set(SYSTEM_ROLES.flatMap((r) => r.permissions));
  return {
    organizationId,
    userId,
    userName,
    actorType: 'user',
    sourceInterface: 'import',
    permissions: allPermissions,
    scopes: null,
    requestId: `seed-${randomUUID().slice(0, 8)}`,
  };
}

// ---------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------

async function createTaxonomy(ctx: ActorContext): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  const create = async (name: string, parent?: string, description?: string) => {
    const category = await createCategory(ctx, {
      name,
      parentCategoryId: parent ? ids[parent] : null,
      description,
    });
    ids[name] = category.id;
    return category.id;
  };

  await create('Metabolic Health');
  await create('Diabetes', 'Metabolic Health');
  await create('Type 2 Diabetes', 'Diabetes');
  await create('Prediabetes', 'Diabetes');
  await create('Insulin Resistance', 'Metabolic Health');
  await create('Metabolic Syndrome', 'Metabolic Health');

  await create('Monitoring and Diagnostics');
  await create('Blood Glucose', 'Monitoring and Diagnostics');
  await create('HbA1c', 'Monitoring and Diagnostics');
  await create('Continuous Glucose Monitoring', 'Monitoring and Diagnostics');

  await create('Lifestyle Interventions');
  await create('Nutrition', 'Lifestyle Interventions');
  await create('Physical Activity', 'Lifestyle Interventions');
  await create('Sleep', 'Lifestyle Interventions');
  await create('Stress and Mental Wellbeing', 'Lifestyle Interventions');

  await create('Complementary Approaches');
  await create('Naturopathy', 'Complementary Approaches');
  await create('Acupressure', 'Complementary Approaches');

  await create('Care and Education');
  await create('Patient Education', 'Care and Education');
  await create('Clinical Safety', 'Care and Education');

  console.log(`  ${Object.keys(ids).length} categories created.`);
  return ids;
}

async function createTags(orgId: string): Promise<void> {
  const tagNames = [
    'walking', 'glucose', 'diabetes', 'insulin sensitivity', 'meal timing', 'fasting',
    'fibre', 'protein', 'HbA1c', 'continuous glucose monitoring', 'postprandial',
    'resistance training', 'aerobic exercise', 'sleep duration', 'circadian rhythm',
    'stress', 'meditation', 'yoga', 'naturopathy', 'acupressure', 'weight management',
    'obesity', 'India', 'randomized controlled trial', 'systematic review', 'cohort study',
    'patient education', 'medication adherence', 'remission', 'prevention', 'screening',
    'micronutrients', 'carbohydrate quality', 'behaviour change',
  ];

  await withOrg(orgId, async (sql) => {
    for (const name of tagNames) {
      await sql.query(
        `INSERT INTO tags (organization_id, name, normalized_name) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, normalized_name) DO NOTHING`,
        [orgId, name, name.toLowerCase()],
      );
    }
  });
  console.log(`  ${tagNames.length} tags created.`);
}

// ---------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------

interface SeedSource {
  key: string;
  id: string;
  title: string;
}

const SOURCE_SPECS: Array<{
  key: string;
  title: string;
  sourceType: string;
  category: string;
  tags: string[];
  text: string;
}> = [
  {
    key: 'walking-rct',
    title: 'SAMPLE DATA: Post-meal walking and postprandial glucose in adults with type 2 diabetes: a randomized controlled trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Type 2 Diabetes',
    tags: ['walking', 'glucose', 'postprandial'],
    text: `Abstract: We conducted a randomized controlled trial (n = 250) among adults with type 2 diabetes in urban India to test whether a 15-minute walk after each main meal reduces postprandial glucose excursions compared to a sedentary control group.

Methods: Participants (n=250, mean age 54) were randomized 1:1 to a 12-week walking intervention or usual care. The primary outcome was postprandial glucose measured by continuous glucose monitoring at 12 weeks.

Results: Post-meal walking significantly reduced postprandial glucose excursions compared to the control group (p < 0.01, 95% CI -18.2 to -6.4 mg/dL). The effect was most pronounced after the largest meal of the day. Mean HbA1c decreased by 0.4 percentage points in the walking group versus 0.05 in control.

Adverse events: No serious adverse events were reported. Two participants reported mild joint discomfort.

Limitations: The study was conducted over 12 weeks; longer-term effects on HbA1c are unknown. The sample was drawn from urban clinics in India and may not generalize to rural populations.

Funding: This study was funded by an institutional grant with no involvement from industry sponsors.

Conflicts of interest: The authors declare no conflicts of interest.`,
  },
  {
    key: 'walking-meta',
    title: 'SAMPLE DATA: Timing of physical activity relative to meals and glycaemic control: a systematic review and meta-analysis',
    sourceType: 'meta_analysis',
    category: 'Physical Activity',
    tags: ['walking', 'meal timing', 'glucose', 'systematic review'],
    text: `Abstract: We performed a systematic review and meta-analysis of 14 randomized trials (total n = 1,842) examining whether the timing of physical activity relative to meals affects postprandial glycaemia.

Methods: We searched MEDLINE, EMBASE and CENTRAL through 2023 for randomized trials comparing post-meal activity to pre-meal or fasted activity, or to no activity, in adults with or at risk of type 2 diabetes.

Results: Post-meal activity was associated with significantly greater reductions in postprandial glucose area-under-curve than pre-meal activity (standardized mean difference -0.62, 95% CI -0.84 to -0.40). Effects were consistent across walking, cycling and resistance-based protocols.

Heterogeneity: Moderate heterogeneity was observed (I2 = 54%), driven largely by differences in activity duration and population baseline glycaemic status.

Limitations: Most included trials were short-duration (under 16 weeks) efficacy studies conducted in high-resource settings; few trials enrolled South Asian populations specifically.

Funding: No external funding was received for this review.`,
  },
  {
    key: 'resistance-training',
    title: 'SAMPLE DATA: Resistance training and insulin sensitivity in prediabetes: a 24-week randomized trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Insulin Resistance',
    tags: ['resistance training', 'insulin sensitivity'],
    text: `Abstract: This 24-week randomized controlled trial (n=180) tested twice-weekly supervised resistance training against a waitlist control in adults with prediabetes.

Methods: The primary outcome was insulin sensitivity measured by the Matsuda index from an oral glucose tolerance test at baseline and 24 weeks.

Results: Resistance training significantly improved insulin sensitivity compared to control (mean difference in Matsuda index +1.8, p=0.003). Fasting insulin decreased by 18% in the intervention group.

Limitations: The trial was conducted in a single urban center with a majority male sample (68%), which may limit generalizability to women and rural populations.

Conflicts of interest: One author has received speaking fees from a fitness equipment manufacturer unrelated to this study.`,
  },
  {
    key: 'sleep-glucose-cohort',
    title: 'SAMPLE DATA: Sleep duration and glycaemic control: a prospective cohort study',
    sourceType: 'cohort_study',
    category: 'Sleep',
    tags: ['sleep duration', 'glucose', 'cohort study'],
    text: `Abstract: We followed a prospective cohort of 3,400 adults without diabetes at baseline for a median of 6 years to examine the association between self-reported sleep duration and incident type 2 diabetes.

Methods: Sleep duration was assessed by questionnaire at baseline. Incident diabetes was defined by fasting glucose, HbA1c, or self-reported physician diagnosis during follow-up.

Results: Short sleep duration (less than 6 hours) was associated with higher incidence of type 2 diabetes compared to 7-8 hours (hazard ratio 1.34, 95% CI 1.09-1.65), after adjustment for BMI, age, and physical activity. Long sleep duration (over 9 hours) was also associated with modestly higher risk (HR 1.21).

Limitations: This is an observational cohort; residual confounding by unmeasured factors such as sleep quality and shift work cannot be excluded. Sleep duration was self-reported rather than measured objectively. As an observational design, this study cannot establish causation.`,
  },
  {
    key: 'naturopathy-review',
    title: 'SAMPLE DATA: Naturopathic approaches to metabolic health: a narrative review',
    sourceType: 'web_article',
    category: 'Naturopathy',
    tags: ['naturopathy', 'weight management'],
    text: `This article reviews commonly discussed naturopathic approaches to metabolic health, including dietary pattern changes, herbal supplementation, and stress reduction practices.

The author, a practicing naturopath, argues that an integrative approach combining conventional and naturopathic care may improve patient outcomes, though acknowledges that high-quality controlled trials of many naturopathic interventions remain limited.

We believe that further research combining naturopathic and conventional approaches would benefit patients, though this recommendation is based on clinical experience rather than trial evidence presented in this piece.`,
  },
  {
    key: 'acupressure-glucose',
    title: 'SAMPLE DATA: Acupressure for glycaemic control: a pilot randomized controlled trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Acupressure',
    tags: ['acupressure', 'glucose'],
    text: `Abstract: This pilot randomized controlled trial (n=42) examined the feasibility and preliminary effect of an 8-week acupressure protocol on fasting glucose in adults with type 2 diabetes.

Methods: Participants were randomized to acupressure plus usual care or usual care alone.

Results: Fasting glucose decreased modestly in the acupressure group compared to control (mean difference -8.2 mg/dL), though this pilot study was not powered to detect statistical significance and the result should be interpreted as preliminary and hypothesis-generating only.

Limitations: This was a small, unblinded pilot study. Sample size was insufficient to draw firm conclusions. Larger, blinded trials are needed before any efficacy claim can be made.`,
  },
  {
    key: 'fibre-metaanalysis',
    title: 'SAMPLE DATA: Dietary fibre intake and HbA1c in type 2 diabetes: a meta-analysis of randomized trials',
    sourceType: 'meta_analysis',
    category: 'Nutrition',
    tags: ['fibre', 'HbA1c'],
    text: `Abstract: We meta-analyzed 28 randomized controlled trials (n=1,910) examining the effect of increased dietary fibre intake on HbA1c in adults with type 2 diabetes.

Results: Increased fibre intake significantly reduced HbA1c compared to control diets (weighted mean difference -0.55%, 95% CI -0.72 to -0.38, p<0.001). Soluble fibre showed a larger effect than insoluble fibre.

Adverse events: Mild gastrointestinal symptoms (bloating, flatulence) were more common in high-fibre intervention arms but were generally well tolerated.

Limitations: Trial durations ranged widely (4 to 52 weeks) and dietary adherence was self-reported in most included trials, introducing potential measurement error.

Funding: Partially funded by a national nutrition research grant; no food industry funding was involved.`,
  },
  {
    key: 'cgm-guideline',
    title: 'SAMPLE DATA: Clinical guideline: use of continuous glucose monitoring in type 2 diabetes management',
    sourceType: 'clinical_guideline',
    category: 'Continuous Glucose Monitoring',
    tags: ['continuous glucose monitoring', 'HbA1c'],
    text: `This clinical guideline summarizes recommendations for the use of continuous glucose monitoring (CGM) devices in adults with type 2 diabetes, based on a review of the trial evidence current as of this publication.

Recommendation: CGM should be considered for adults with type 2 diabetes on insulin therapy, and may be offered to other adults with type 2 diabetes where access allows, to support self-management and identify patterns not visible from periodic fingerstick testing.

Safety notes: Clinicians should ensure patients are educated on device calibration and troubleshooting to avoid management decisions based on inaccurate readings. CGM does not replace clinical judgement or periodic laboratory HbA1c testing.

Evidence basis: Recommendations are graded by the strength of supporting randomized trial evidence, which is described in the accompanying technical appendix (not included here).`,
  },
  {
    key: 'stress-cortisol',
    title: 'SAMPLE DATA: Chronic stress, cortisol and insulin resistance: a cross-sectional study',
    sourceType: 'cross_sectional_study',
    category: 'Stress and Mental Wellbeing',
    tags: ['stress', 'insulin sensitivity'],
    text: `Abstract: In a cross-sectional sample of 620 adults, we examined the association between perceived chronic stress, hair cortisol concentration, and markers of insulin resistance (HOMA-IR).

Results: Higher perceived stress and higher hair cortisol were both independently associated with higher HOMA-IR (p<0.01 for both). The association was stronger among participants with higher waist circumference.

Limitations: As a cross-sectional study, no causal or temporal relationship can be established between stress, cortisol, and insulin resistance. Reverse causation (insulin resistance causing stress) cannot be excluded.`,
  },
  {
    key: 'meditation-glycemic',
    title: 'SAMPLE DATA: Mindfulness meditation and glycaemic outcomes: a randomized controlled trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Stress and Mental Wellbeing',
    tags: ['meditation', 'glucose'],
    text: `Abstract: This 16-week randomized controlled trial (n=96) tested an 8-week mindfulness-based stress reduction program followed by 8 weeks of home practice, against a waitlist control, on HbA1c in adults with type 2 diabetes and elevated perceived stress.

Results: No significant difference in HbA1c change was observed between groups at 16 weeks (mean difference -0.05%, 95% CI -0.24 to 0.14, p=0.61). Perceived stress scores improved significantly in the intervention group relative to control.

Limitations: The trial may have been underpowered to detect a small HbA1c effect. Adherence to home practice after the supervised phase was not objectively verified.`,
  },
  {
    key: 'yoga-metabolic',
    title: 'SAMPLE DATA: Yoga-based lifestyle intervention for metabolic syndrome: a randomized controlled trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Metabolic Syndrome',
    tags: ['yoga', 'obesity'],
    text: `Abstract: We randomized 210 adults with metabolic syndrome to a 12-week structured yoga-based lifestyle program or standard lifestyle advice.

Results: The yoga intervention group showed significant improvements in waist circumference, triglycerides, and fasting glucose compared to control (all p<0.05). No significant between-group difference was observed for HDL cholesterol or blood pressure.

Limitations: The intervention combined yoga postures with breathing exercises and dietary counselling as a bundled program, so the independent contribution of yoga itself cannot be isolated from this trial design.

Funding: Funded by a government AYUSH research grant.`,
  },
  {
    key: 'intermittent-fasting',
    title: 'SAMPLE DATA: Intermittent fasting versus continuous caloric restriction for weight loss: a randomized trial',
    sourceType: 'randomized_controlled_trial',
    category: 'Nutrition',
    tags: ['fasting', 'weight management'],
    text: `Abstract: This 6-month randomized trial (n=150) compared 16:8 time-restricted eating to continuous daily caloric restriction (matched for total energy deficit) for weight loss in adults with overweight or obesity.

Results: Both groups lost significant weight from baseline (time-restricted eating: -7.1 kg; continuous restriction: -6.8 kg), with no significant between-group difference (p=0.62). HbA1c improved similarly in both groups among the subset with prediabetes.

Limitations: Dietary adherence was self-reported. The trial was not designed or powered to detect small between-group differences, so equivalence cannot be firmly concluded from a non-significant result alone.`,
  },
  {
    key: 'micronutrient-blog',
    title: 'SAMPLE DATA: 5 micronutrients every diabetic should know about',
    sourceType: 'web_article',
    category: 'Nutrition',
    tags: ['micronutrients'],
    text: `This wellness blog post discusses five micronutrients -- magnesium, chromium, vitamin D, zinc and B12 -- that are commonly discussed in relation to blood sugar management.

The article recommends specific supplement dosages and states that magnesium supplementation "will lower your blood sugar." No citations to clinical trials are provided in the article, and specific dosage claims are not attributed to any study.

The piece is written for a general consumer audience and includes affiliate links to supplement products.`,
  },
  {
    key: 'carbohydrate-quality',
    title: 'SAMPLE DATA: Carbohydrate quality and long-term diabetes risk: a prospective cohort analysis',
    sourceType: 'cohort_study',
    category: 'Nutrition',
    tags: ['carbohydrate quality', 'prevention'],
    text: `Abstract: Using data from a prospective cohort of 12,000 adults followed for a median of 9 years, we examined the association between dietary glycaemic index, glycaemic load, and incident type 2 diabetes.

Results: Higher dietary glycaemic load was associated with increased diabetes risk (hazard ratio 1.28 comparing highest to lowest quintile, 95% CI 1.11-1.48), independent of total carbohydrate intake and BMI.

Limitations: Dietary intake was assessed by food frequency questionnaire at baseline only and may not reflect changes in diet over the follow-up period. As an observational study, causation cannot be established from this design alone.`,
  },
  {
    key: 'behaviour-change-adherence',
    title: 'SAMPLE DATA: Behaviour change techniques and medication adherence in type 2 diabetes: a systematic review',
    sourceType: 'systematic_review',
    category: 'Patient Education',
    tags: ['behaviour change', 'medication adherence', 'patient education'],
    text: `Abstract: We systematically reviewed 22 randomized trials evaluating behaviour change interventions to improve medication adherence in adults with type 2 diabetes.

Results: Interventions incorporating self-monitoring and structured goal-setting were associated with the largest improvements in adherence (typically 10-20 percentage points), though effect sizes varied substantially across studies and settings.

Limitations: Adherence was measured using varied methods across studies (self-report, pill counts, pharmacy refill data), limiting direct comparability. Long-term (over 12 months) adherence data was sparse.`,
  },
  {
    key: 'internal-screening-protocol',
    title: 'SAMPLE DATA: Nirog Bhoomi internal protocol: diabetes screening intake questions',
    sourceType: 'internal_document',
    category: 'Screening',
    tags: ['screening', 'patient education'],
    text: `This internal document sets out the standard intake screening questions used by Nirog Bhoomi coaches when a new member reports a prior diagnosis of prediabetes or type 2 diabetes.

Questions cover current medications, most recent HbA1c if known, prior complications, and current physical activity level. Coaches are instructed to refer members with HbA1c above 9% or reported hypoglycaemic episodes to a physician before beginning any lifestyle program.

This is an internal operational document, not a research source, and is included in the library for reference by the content and clinical teams.`,
  },
  {
    key: 'retracted-supplement-study',
    title: 'SAMPLE DATA: [Retraction pending] Herbal supplement X and rapid glycaemic normalization: an open-label trial',
    sourceType: 'research_paper',
    category: 'Naturopathy',
    tags: ['naturopathy'],
    text: `Abstract: In this open-label trial (n=40), a proprietary herbal supplement was reported to normalize fasting glucose within 4 weeks in the majority of participants with type 2 diabetes.

Note: Concerns have been raised by other researchers about data inconsistencies in this study, and an investigation by the publishing journal is ongoing. This source is retained in the library with a retraction warning pending the outcome of that investigation and should not be used as a basis for any claim without independent verification.`,
  },
  {
    key: 'walking-superseded-v1',
    title: 'SAMPLE DATA: Walking after meals and blood sugar: preliminary findings (superseded)',
    sourceType: 'research_paper',
    category: 'Physical Activity',
    tags: ['walking', 'glucose'],
    text: `Abstract: This preliminary report (n=30) suggested that walking after meals may reduce blood sugar spikes, based on a small unblinded pilot study.

Note: This preliminary report has been superseded by a larger, adequately powered randomized controlled trial from the same research group (see the linked superseding source in this library). Conclusions here should not be relied upon in preference to the superseding study.`,
  },
  {
    key: 'gestational-diabetes-review',
    title: 'SAMPLE DATA: Lifestyle interventions in gestational diabetes: a systematic review',
    sourceType: 'systematic_review',
    category: 'Diabetes',
    tags: ['prevention'],
    text: `Abstract: We reviewed 19 randomized trials of lifestyle interventions (diet, physical activity, or combined) for the management of gestational diabetes.

Results: Combined diet and physical activity interventions were associated with modest reductions in the need for pharmacological treatment compared to usual care (relative risk 0.82, 95% CI 0.71-0.95).

Limitations: Included trials varied substantially in intervention intensity and control group care, limiting the precision of the pooled estimate. Long-term postpartum outcomes were rarely reported.`,
  },
  {
    key: 'unreviewed-social-post',
    title: 'SAMPLE DATA: Thread: what actually helped my blood sugar (patient anecdote)',
    sourceType: 'social_post',
    category: 'Patient Education',
    tags: ['patient education'],
    text: `A patient describes their personal experience managing type 2 diabetes through diet changes, walking, and medication adherence over 18 months, including specific numbers from their own glucose meter readings.

This is a single anecdotal account, not a controlled study, and should not be treated as generalizable evidence. It may be useful for understanding patient perspective and language for content development, with appropriate framing.`,
  },
];

async function createSources(
  ctx: ActorContext,
  categories: Record<string, string>,
): Promise<Record<string, SeedSource>> {
  const sources: Record<string, SeedSource> = {};

  for (const spec of SOURCE_SPECS) {
    const result = await createManualSource(ctx, {
      title: spec.title,
      text: spec.text,
      sourceType: spec.sourceType,
      categoryIds: categories[spec.category] ? [categories[spec.category]] : [],
      tags: spec.tags,
    });
    sources[spec.key] = { key: spec.key, id: result.source_id, title: result.title };
  }

  console.log(`  ${Object.keys(sources).length} sources created.`);
  return sources;
}

async function runAllQueuedJobs(): Promise<void> {
  let processed = 0;
  for (;;) {
    const job = await claimNextJob('seed-worker');
    if (!job) break;
    const handler = HANDLERS[job.job_type];
    if (!handler) continue;
    try {
      await handler(job, contextForJob(job, `seed-job-${job.id.slice(0, 8)}`));
      const { completeJob } = await import('../src/services/processing');
      await completeJob(job.id, { output: {}, warnings: [] });
    } catch (err) {
      const { failJob } = await import('../src/services/processing');
      await failJob(job.id, {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'seed processing error',
        retryable: false,
      });
    }
    processed += 1;
  }
  console.log(`  ${processed} processing job(s) run.`);
}

async function applyReviewStates(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<void> {
  const approve = async (key: string, conditions?: string[]) => {
    await changeReviewStatus(ctx, sources[key].id, {
      status: conditions ? 'approved_with_conditions' : 'approved',
      conditions,
    });
  };
  const reject = async (key: string, reason: string) => {
    await changeReviewStatus(ctx, sources[key].id, { status: 'needs_review' });
    await changeReviewStatus(ctx, sources[key].id, { status: 'in_review' });
    await changeReviewStatus(ctx, sources[key].id, { status: 'rejected', reason });
  };

  await approve('walking-rct');
  await approve('walking-meta');
  await approve('resistance-training');
  await approve('sleep-glucose-cohort');
  await approve('fibre-metaanalysis');
  await approve('cgm-guideline');
  await approve('carbohydrate-quality');
  await approve('behaviour-change-adherence');
  await approve('gestational-diabetes-review');
  await approve('yoga-metabolic', ['Frame findings as part of a bundled lifestyle program, not yoga alone.']);
  await approve('intermittent-fasting', ['State clearly that this shows equivalence to caloric restriction, not superiority.']);

  await reject('micronutrient-blog', 'No clinical evidence cited for the dosage and efficacy claims made; contains affiliate marketing content.');

  // Left unreviewed / needs_review deliberately: acupressure-glucose,
  // stress-cortisol, meditation-glycemic, naturopathy-review,
  // internal-screening-protocol, unreviewed-social-post,
  // retracted-supplement-study, walking-superseded-v1.
  console.log('  Review states applied (approved, conditional, rejected, and left unreviewed).');
}

async function createSpecialScenarios(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<void> {
  await withOrg(ctx.organizationId, async (sql) => {
    // Superseded relationship.
    await sql.query(
      `UPDATE sources SET review_status = 'superseded', superseded_by_source_id = $1 WHERE id = $2`,
      [sources['walking-rct'].id, sources['walking-superseded-v1'].id],
    );
    await sql.query(`UPDATE sources SET supersedes_source_id = $1 WHERE id = $2`, [
      sources['walking-superseded-v1'].id,
      sources['walking-rct'].id,
    ]);

    // Retraction warning.
    await sql.query(
      `UPDATE sources SET retraction_status = 'under_investigation',
              retraction_reason = 'Data inconsistencies reported; publisher investigation ongoing.'
       WHERE id = $1`,
      [sources['retracted-supplement-study'].id],
    );

    // A near-duplicate scenario: mark a duplicate relationship directly
    // for demonstration (the ingestion path already exercises live
    // detection; this records a resolved case for the UI to show).
    await sql.query(
      `UPDATE sources SET duplicate_status = 'near_duplicate', duplicate_of_source_id = $1
       WHERE id = $2`,
      [sources['walking-rct'].id, sources['walking-superseded-v1'].id],
    );
  });
  console.log('  Superseded, retraction-warning and duplicate scenarios recorded.');
}

// ---------------------------------------------------------------------

async function createCollections(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<Record<string, string>> {
  const collections: Record<string, string> = {};

  const walking = await createCollection(ctx, {
    name: 'Post-Meal Walking Evidence',
    researchQuestion: 'Does walking after meals improve glycaemic control?',
    collectionType: 'clinical_topic',
    purpose: 'Central evidence base for content and coaching guidance on post-meal walking.',
  });
  await addSourcesToCollection(ctx, walking.id, {
    sourceIds: [sources['walking-rct'].id, sources['walking-meta'].id, sources['walking-superseded-v1'].id],
  });
  collections.walking = walking.id;

  const lifestyle = await createCollection(ctx, {
    name: 'Lifestyle Interventions for Type 2 Diabetes',
    researchQuestion: 'Which lifestyle interventions have the strongest evidence for type 2 diabetes management?',
    collectionType: 'research_project',
  });
  await addSourcesToCollection(ctx, lifestyle.id, {
    sourceIds: [
      sources['walking-rct'].id,
      sources['resistance-training'].id,
      sources['fibre-metaanalysis'].id,
      sources['intermittent-fasting'].id,
      sources['carbohydrate-quality'].id,
    ],
  });
  collections.lifestyle = lifestyle.id;

  const stress = await createCollection(ctx, {
    name: 'Stress, Sleep and Metabolic Health',
    researchQuestion: 'How do stress and sleep relate to glycaemic outcomes?',
    collectionType: 'clinical_topic',
  });
  await addSourcesToCollection(ctx, stress.id, {
    sourceIds: [sources['sleep-glucose-cohort'].id, sources['stress-cortisol'].id, sources['meditation-glycemic'].id],
  });
  collections.stress = stress.id;

  const complementary = await createCollection(ctx, {
    name: 'Complementary Approaches Evidence Review',
    researchQuestion: 'What does controlled trial evidence show for complementary approaches to metabolic health?',
    collectionType: 'clinical_topic',
  });
  await addSourcesToCollection(ctx, complementary.id, {
    sourceIds: [sources['naturopathy-review'].id, sources['acupressure-glucose'].id, sources['yoga-metabolic'].id],
  });
  collections.complementary = complementary.id;

  const contentProject = await createCollection(ctx, {
    name: 'Q3 Patient Education Content Project',
    collectionType: 'content_project',
    purpose: 'Source pool for the next round of patient-facing educational content.',
  });
  await addSourcesToCollection(ctx, contentProject.id, {
    sourceIds: [
      sources['walking-rct'].id,
      sources['cgm-guideline'].id,
      sources['behaviour-change-adherence'].id,
      sources['internal-screening-protocol'].id,
    ],
  });
  collections.contentProject = contentProject.id;

  console.log(`  ${Object.keys(collections).length} collections created.`);
  return collections;
}

// ---------------------------------------------------------------------

async function createClaimsAndEvidence(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<void> {
  const claim1 = await createClaim(ctx, {
    canonicalText: 'A short walk after meals reduces postprandial glucose excursions in adults with type 2 diabetes.',
    population: 'Adults with type 2 diabetes',
    intervention: 'Post-meal walking (10-15 minutes)',
    outcome: 'Postprandial glucose excursion',
    sourceEvidence: [
      { sourceId: sources['walking-rct'].id, relationship: 'supports' },
      { sourceId: sources['walking-meta'].id, relationship: 'supports' },
    ],
  });
  await (await import('../src/services/claim')).reviewClaim(ctx, claim1.id as string, {
    evidenceStatus: 'supported',
    clinicalReviewStatus: 'reviewed',
    rationale: 'Consistent effect across an RCT and a meta-analysis of 14 trials with a clear mechanism.',
  });

  await createClaim(ctx, {
    canonicalText: 'Resistance training improves insulin sensitivity in adults with prediabetes.',
    population: 'Adults with prediabetes',
    intervention: 'Supervised resistance training, twice weekly',
    outcome: 'Insulin sensitivity (Matsuda index)',
    sourceEvidence: [{ sourceId: sources['resistance-training'].id, relationship: 'supports' }],
  });

  // A disputed / contested claim: mindfulness shows no significant
  // glycaemic effect while stress is cross-sectionally associated with
  // insulin resistance -- a genuine tension worth surfacing, not a
  // simple contradiction.
  const stressClaim = await createClaim(ctx, {
    canonicalText: 'Mindfulness-based stress reduction improves HbA1c in adults with type 2 diabetes.',
    population: 'Adults with type 2 diabetes and elevated stress',
    intervention: 'Mindfulness-based stress reduction program',
    outcome: 'HbA1c',
    sourceEvidence: [
      { sourceId: sources['meditation-glycemic'].id, relationship: 'contradicts' },
      { sourceId: sources['stress-cortisol'].id, relationship: 'qualifies' },
    ],
  });
  await (await import('../src/services/claim')).reviewClaim(ctx, stressClaim.id as string, {
    evidenceStatus: 'contested',
    clinicalReviewStatus: 'reviewed',
    rationale: 'The only RCT found no significant HbA1c effect despite improving perceived stress; a cross-sectional study shows an association between stress and insulin resistance but cannot establish that reducing stress improves HbA1c. Do not present mindfulness as an established glycaemic intervention.',
  });

  await createClaim(ctx, {
    canonicalText: 'Higher dietary fibre intake reduces HbA1c in adults with type 2 diabetes.',
    population: 'Adults with type 2 diabetes',
    intervention: 'Increased dietary fibre intake',
    outcome: 'HbA1c',
    sourceEvidence: [{ sourceId: sources['fibre-metaanalysis'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Short sleep duration is associated with increased risk of incident type 2 diabetes.',
    population: 'Adults without diabetes at baseline',
    outcome: 'Incident type 2 diabetes',
    sourceEvidence: [{ sourceId: sources['sleep-glucose-cohort'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Time-restricted eating produces similar weight loss to continuous caloric restriction when energy intake is matched.',
    population: 'Adults with overweight or obesity',
    intervention: '16:8 time-restricted eating',
    comparator: 'Continuous daily caloric restriction',
    outcome: 'Body weight',
    sourceEvidence: [{ sourceId: sources['intermittent-fasting'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Higher dietary glycaemic load is associated with increased long-term risk of type 2 diabetes.',
    population: 'General adult population',
    outcome: 'Incident type 2 diabetes',
    sourceEvidence: [{ sourceId: sources['carbohydrate-quality'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'A structured yoga-based lifestyle program improves waist circumference and fasting glucose in metabolic syndrome.',
    population: 'Adults with metabolic syndrome',
    intervention: 'Structured yoga-based lifestyle program',
    outcome: 'Waist circumference and fasting glucose',
    context: 'The program bundled yoga with breathing exercises and dietary counselling; the independent effect of yoga alone is not established by this trial.',
    sourceEvidence: [{ sourceId: sources['yoga-metabolic'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Behaviour change techniques incorporating self-monitoring improve medication adherence in type 2 diabetes.',
    population: 'Adults with type 2 diabetes',
    intervention: 'Self-monitoring and structured goal-setting',
    outcome: 'Medication adherence',
    sourceEvidence: [{ sourceId: sources['behaviour-change-adherence'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Combined diet and physical activity intervention reduces the need for pharmacological treatment in gestational diabetes.',
    population: 'Pregnant women with gestational diabetes',
    intervention: 'Combined diet and physical activity',
    outcome: 'Need for pharmacological treatment',
    sourceEvidence: [{ sourceId: sources['gestational-diabetes-review'].id, relationship: 'supports' }],
  });

  await createClaim(ctx, {
    canonicalText: 'Magnesium supplementation lowers blood sugar in people with diabetes.',
    population: 'People with diabetes',
    intervention: 'Magnesium supplementation',
    outcome: 'Blood glucose',
    safetyRelevance: 'review_required',
    sourceEvidence: [{ sourceId: sources['micronutrient-blog'].id, relationship: 'cites' }],
  });
  // This claim is intentionally left unreviewed with weak, uncited-trial
  // sourcing, to demonstrate the "insufficient evidence" path.

  console.log('  12 claims created with supporting/contradicting/qualifying evidence.');
}

// ---------------------------------------------------------------------

async function createAnnotations(
  contentCtx: ActorContext,
  clinicalCtx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<void> {
  await createAnnotation(contentCtx, {
    sourceId: sources['walking-rct'].id,
    annotationType: 'content_idea',
    body: 'Good candidate for a short "10-minute walk after dinner" patient guide -- strong RCT evidence and a simple, actionable behaviour.',
  });

  await createAnnotation(clinicalCtx, {
    sourceId: sources['acupressure-glucose'].id,
    annotationType: 'safety_warning',
    body: 'Pilot study only, not powered for efficacy. Do not present this as evidence that acupressure lowers blood sugar in any patient-facing content.',
  });

  await createAnnotation(clinicalCtx, {
    sourceId: sources['retracted-supplement-study'].id,
    annotationType: 'safety_warning',
    body: 'Retraction investigation ongoing. Do not cite this source in any content or claim until resolved.',
  });

  await createAnnotation(contentCtx, {
    sourceId: sources['micronutrient-blog'].id,
    annotationType: 'correction',
    body: 'The magnesium dosage claim in this article is not supported by a cited trial. Flagged for rejection.',
  });

  await createAnnotation(clinicalCtx, {
    sourceId: sources['meditation-glycemic'].id,
    annotationType: 'important_statistic',
    body: 'No significant HbA1c difference (mean difference -0.05%, 95% CI -0.24 to 0.14). Trial may be underpowered -- do not read this as proof of no effect.',
  });

  console.log('  5 annotations created.');
}

// ---------------------------------------------------------------------

async function createBriefs(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
  collections: Record<string, string>,
): Promise<void> {
  const brief1 = await createBrief(ctx, {
    title: 'SAMPLE DATA: Evidence Review -- Post-Meal Walking for Glycaemic Control',
    briefType: 'evidence_review',
    researchQuestion: 'Does walking after meals improve glycaemic control in adults with type 2 diabetes?',
    collectionIds: [collections.walking],
    approvedOnly: true,
  });
  await generateBrief(ctx, brief1.id as string, {});

  const brief2 = await createBrief(ctx, {
    title: 'SAMPLE DATA: Content Research Brief -- Lifestyle Interventions for Type 2 Diabetes',
    briefType: 'content_research',
    researchQuestion: 'What lifestyle interventions have the strongest approved evidence base for patient-facing content?',
    collectionIds: [collections.lifestyle],
    approvedOnly: true,
    audience: 'content_team',
  });
  await generateBrief(ctx, brief2.id as string, {});

  console.log('  2 research briefs created and generated.');
}

// ---------------------------------------------------------------------

async function seedProcessingJobStates(
  ctx: ActorContext,
  sources: Record<string, SeedSource>,
): Promise<void> {
  // A queued job awaiting a worker.
  await enqueueStandalone(ctx, {
    jobType: 'summarize',
    sourceId: sources['unreviewed-social-post'].id,
    dedupeKey: `seed-queued-${sources['unreviewed-social-post'].id}`,
  });

  // A dead-lettered job, to populate the operations page's failure view.
  await withOrg(ctx.organizationId, (sql) =>
    sql.query(
      `INSERT INTO processing_jobs (
         organization_id, source_id, job_type, status, attempt_count, max_attempts,
         error_code, error_message, started_at, completed_at
       ) VALUES ($1,$2,'claims','dead_letter',3,3,'AI_PROCESSING_FAILED',
                 'The extraction model timed out after 3 attempts.', now() - interval '2 days', now() - interval '2 days')`,
      [ctx.organizationId, sources['retracted-supplement-study'].id],
    ),
  );

  console.log('  1 queued job and 1 dead-lettered job seeded for the operations view.');
}

main().catch(async (err) => {
  console.error('SEED FAILED:');
  reportError(err);
  await closePool();
  process.exit(1);
});
