import { complete, type AiCallContext } from './provider';
import {
  ClaimExtractionSchema,
  ClassificationSchema,
  ContradictionAnalysisSchema,
  EvidenceAssessmentSchema,
  MetadataExtractionSchema,
  QueryUnderstandingSchema,
  StudyExtractionSchema,
  SummarySchema,
  SynthesisSchema,
  GeneratedContentSchema,
  BriefSectionSchema,
  type ClaimExtraction,
  type Classification,
  type ContradictionAnalysis,
  type EvidenceAssessment,
  type MetadataExtraction,
  type QueryUnderstanding,
  type StudyExtraction,
  type Summary,
  type Synthesis,
  type GeneratedContentOutput,
  type BriefSectionOutput,
} from './schemas';

/**
 * Every stage of the enrichment pipeline. Prompts live here rather than
 * being scattered through the services, so the instructions the models
 * receive can be reviewed in one place.
 */

const HONESTY_RULES = `
Rules that override any preference for a complete-looking answer:
- Report a field as null when the document does not state it. Never infer,
  estimate or fill a plausible value.
- Never invent a page number, DOI, date, author, journal or statistic.
- Preserve the source's own hedging. If the source says "may reduce", do
  not report "reduces".
- Do not convert an association into a cause.
`.trim();

export async function extractMetadata(
  ctx: AiCallContext,
  input: { text: string; url?: string; title?: string; publisher?: string; sourceType?: string },
): Promise<MetadataExtraction> {
  return complete(ctx, {
    capability: 'extraction',
    schema: MetadataExtractionSchema,
    schemaName: 'MetadataExtraction',
    system: `You extract bibliographic metadata from documents. ${HONESTY_RULES}`,
    instruction:
      'Extract bibliographic metadata from the document. Classify the source type from how the document is structured and what it reports, not from where it was published.',
    payload: {
      url: input.url ?? null,
      title: input.title ?? null,
      publisher: input.publisher ?? null,
      source_type: input.sourceType ?? null,
    },
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 60_000) }],
  });
}

export async function summarizeSource(
  ctx: AiCallContext,
  input: { text: string; title: string },
): Promise<Summary> {
  return complete(ctx, {
    capability: 'extraction',
    schema: SummarySchema,
    schemaName: 'Summary',
    system: `You summarize research documents for a health research team. ${HONESTY_RULES}

Separate what the document found from what it recommends and from what its
authors believe. Surface limitations and safety implications even when the
document downplays them.`,
    instruction: `Summarize the document titled "${input.title}" at several levels of detail, and list its key findings, practical implications, limitations, safety implications, and any questions a reviewer should resolve.`,
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 60_000) }],
  });
}

export async function classifySource(
  ctx: AiCallContext,
  input: {
    text: string;
    title: string;
    candidateCategories: Array<{ id: string; name: string; synonyms?: string[]; guidance?: string }>;
    candidateCollections?: Array<{ id: string; name: string; research_question?: string }>;
    allowNewCategoryProposals: boolean;
  },
): Promise<Classification> {
  return complete(ctx, {
    capability: 'fast',
    schema: ClassificationSchema,
    schemaName: 'Classification',
    system: `You assign documents to an existing controlled taxonomy.

Prefer an existing category over proposing a new one. Proposing a near-
duplicate of an existing category is worse than leaving a document
slightly under-classified, because duplicate taxonomy is expensive to
undo. ${input.allowNewCategoryProposals ? 'You may propose new categories, but each proposal must list the existing categories it is closest to.' : 'Do not propose new categories.'}`,
    instruction: `Classify the document "${input.title}" against the candidate categories. Assign only categories the document is genuinely about, with a calibrated confidence for each.`,
    payload: {
      candidate_categories: input.candidateCategories,
      candidate_collections: input.candidateCollections ?? [],
      allow_new_category_proposals: input.allowNewCategoryProposals,
    },
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 30_000) }],
  });
}

export async function extractStudyMetadata(
  ctx: AiCallContext,
  input: { text: string; title: string },
): Promise<StudyExtraction> {
  return complete(ctx, {
    capability: 'extraction',
    schema: StudyExtractionSchema,
    schemaName: 'StudyExtraction',
    system: `You extract study methodology and PICO structure from research papers. ${HONESTY_RULES}

Every field carries its own confidence and the verbatim excerpt it came
from. A field with no supporting excerpt must be null with confidence 0.`,
    instruction: `Extract the study design, population, intervention, comparator, outcomes, statistics, funding and limitations from "${input.title}". If the document is not a study, set is_study to false and leave the fields null.`,
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 60_000) }],
  });
}

export async function extractClaims(
  ctx: AiCallContext,
  input: { text: string; title: string },
): Promise<ClaimExtraction> {
  return complete(ctx, {
    capability: 'extraction',
    schema: ClaimExtractionSchema,
    schemaName: 'ClaimExtraction',
    system: `You extract atomic, checkable factual claims from research documents. ${HONESTY_RULES}

Most sentences are not claims. Extract a claim only when it asserts a
specific relationship that could be supported or contradicted by
evidence. Background statements, methods descriptions and transitions are
not claims.

Classify each claim by what it actually is in the document: the source's
own finding, a claim it cites from elsewhere, an author opinion, or a
recommendation. Collapsing these distinctions is how an author's aside
becomes an organizational fact.`,
    instruction: `Extract the meaningful atomic claims from "${input.title}", each with its population, intervention, comparator, outcome, timeframe, qualifiers, and the verbatim excerpt supporting it. Extract at most 12.`,
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 60_000) }],
  });
}

export async function analyzeContradictions(
  ctx: AiCallContext,
  input: {
    subjectText: string;
    subjectContext?: Record<string, unknown>;
    targets: Array<{ claim_id?: string; source_id?: string; text: string; context?: Record<string, unknown> }>;
  },
): Promise<ContradictionAnalysis> {
  return complete(ctx, {
    capability: 'synthesis',
    schema: ContradictionAnalysisSchema,
    schemaName: 'ContradictionAnalysis',
    system: `You compare research claims to determine whether they genuinely conflict.

Most apparent contradictions are not contradictions. Before classifying
anything as a true contradiction, check whether the statements differ in
population, intervention intensity or dose, comparator, outcome
definition, follow-up duration, study design, or context. If they differ
in any of those, classify it as that difference instead.

Your output is a suggestion for a human reviewer, never a verdict.`,
    instruction:
      'Compare the subject statement against each target statement and classify the relationship along the listed dimensions.',
    payload: {
      subject_text: input.subjectText,
      subject_context: input.subjectContext ?? {},
      comparison_targets: input.targets,
    },
  });
}

export async function assessEvidence(
  ctx: AiCallContext,
  input: {
    text: string;
    sourceType: string;
    publicationYear?: number | null;
    sampleSize?: number | null;
    studyDesign?: string | null;
  },
): Promise<EvidenceAssessment> {
  return complete(ctx, {
    capability: 'fast',
    schema: EvidenceAssessmentSchema,
    schemaName: 'EvidenceAssessment',
    system: `You assess research reliability across independent dimensions.

Do not collapse these into a single verdict, and do not let one strong
dimension carry the others. Where a dimension cannot be judged from the
available text, answer "unknown" rather than guessing.`,
    instruction:
      'Assess this source on each dimension and explain the reasoning in one short paragraph.',
    payload: {
      source_type: input.sourceType,
      publication_year: input.publicationYear ?? null,
      sample_size: input.sampleSize ?? null,
      study_design: input.studyDesign ?? null,
    },
    untrustedContent: [{ label: 'document', text: input.text.slice(0, 20_000) }],
  });
}

export interface SynthesisPassage {
  marker: string;
  source_id: string;
  title: string;
  text: string;
  review_status: string;
  source_type: string;
  publication_date?: string | null;
  locator?: string | null;
}

export async function synthesizeEvidence(
  ctx: AiCallContext,
  input: {
    question: string;
    passages: SynthesisPassage[];
    audience: string;
    includeContradictions: boolean;
    includeLimitations: boolean;
    includeSafetyNotes: boolean;
  },
): Promise<Synthesis> {
  return complete(ctx, {
    capability: 'synthesis',
    schema: SynthesisSchema,
    schemaName: 'Synthesis',
    system: `You synthesize evidence for the Nirog Bhoomi research team. ${HONESTY_RULES}

Absolute constraints:
- Use ONLY the supplied passages. If they do not answer the question, say so.
- Every factual statement must carry the citation marker of the passage it
  came from. A statement you cannot cite must not appear.
- Never cite a marker that is not in the supplied passages.
- Distinguish strong evidence from tentative evidence.
- Surface disagreement between passages rather than averaging it away.
- State what is missing, and note the population the evidence came from.
- Use causal language only for experimental designs that support it.
- Note whether the passages are from approved or unreviewed sources.`,
    instruction: `Answer this question using only the supplied passages: ${input.question}`,
    payload: {
      question: input.question,
      audience: input.audience,
      include_contradictions: input.includeContradictions,
      include_limitations: input.includeLimitations,
      include_safety_notes: input.includeSafetyNotes,
      passages: input.passages.map((p) => ({
        marker: p.marker,
        title: p.title,
        text: p.text,
        review_status: p.review_status,
        source_type: p.source_type,
        publication_date: p.publication_date ?? null,
        locator: p.locator ?? null,
      })),
    },
    untrustedContent: input.passages.map((p) => ({
      label: `${p.marker} ${p.title}`,
      text: p.text,
    })),
    maxTokens: 6000,
  });
}

export async function understandQuery(
  ctx: AiCallContext,
  query: string,
): Promise<QueryUnderstanding> {
  return complete(ctx, {
    capability: 'fast',
    schema: QueryUnderstandingSchema,
    schemaName: 'QueryUnderstanding',
    system:
      'You convert a natural-language research question into a structured search specification. Only set a filter the question actually implies; an over-constrained search returns nothing.',
    instruction: `Convert this query into structured search parameters: ${query}`,
    payload: { query },
  });
}

export async function draftContent(
  ctx: AiCallContext,
  input: {
    title: string;
    contentType: string;
    audience: string;
    instructions?: string;
    targetLength?: number;
    brandGuidance?: string;
    prohibitedClaims: string[];
    passages: SynthesisPassage[];
  },
): Promise<GeneratedContentOutput> {
  return complete(ctx, {
    capability: 'synthesis',
    schema: GeneratedContentSchema,
    schemaName: 'GeneratedContent',
    system: `You draft evidence-backed content for Nirog Bhoomi. ${HONESTY_RULES}

Every factual statement must trace to a supplied passage and carry its
citation marker. Anything you cannot support that way belongs in
unsupported_claims, not in the body.

For health content aimed at the public: keep the source's qualifiers,
avoid promising outcomes, never present preliminary findings as
established, and flag anything a clinical reviewer should check.`,
    instruction: `Draft a ${input.contentType} titled "${input.title}" for ${input.audience}.${
      input.instructions ? ` Additional instructions: ${input.instructions}` : ''
    }${input.targetLength ? ` Target roughly ${input.targetLength} words.` : ''}`,
    payload: {
      title: input.title,
      content_type: input.contentType,
      audience: input.audience,
      brand_guidance: input.brandGuidance ?? null,
      prohibited_claims: input.prohibitedClaims,
      passages: input.passages.map((p) => ({
        marker: p.marker,
        title: p.title,
        text: p.text,
        review_status: p.review_status,
      })),
    },
    untrustedContent: input.passages.map((p) => ({
      label: `${p.marker} ${p.title}`,
      text: p.text,
    })),
    maxTokens: 8000,
  });
}

export async function generateBriefSections(
  ctx: AiCallContext,
  input: {
    researchQuestion: string;
    briefType: string;
    audience: string;
    sections: string[];
    passages: SynthesisPassage[];
  },
): Promise<BriefSectionOutput> {
  return complete(ctx, {
    capability: 'synthesis',
    schema: BriefSectionSchema,
    schemaName: 'BriefSection',
    system: `You write research briefs for the Nirog Bhoomi team. ${HONESTY_RULES}

Use only the supplied passages and cite every factual statement with its
marker. Where the evidence is thin or conflicting, say so plainly in the
relevant section rather than smoothing it over.`,
    instruction: `Write the requested sections of a ${input.briefType} brief for ${input.audience} answering: ${input.researchQuestion}`,
    payload: {
      research_question: input.researchQuestion,
      brief_type: input.briefType,
      audience: input.audience,
      sections: input.sections,
      passages: input.passages.map((p) => ({
        marker: p.marker,
        title: p.title,
        text: p.text,
        review_status: p.review_status,
        source_type: p.source_type,
      })),
    },
    untrustedContent: input.passages.map((p) => ({
      label: `${p.marker} ${p.title}`,
      text: p.text,
    })),
    maxTokens: 8000,
  });
}

/**
 * Citations are verified against the retrieval context rather than
 * trusted. A marker the model used that was not supplied is dropped and
 * reported, so a hallucinated citation can never reach a stored record.
 */
export function validateCitations(
  usedMarkers: string[],
  availableMarkers: string[],
): { valid: string[]; invalid: string[] } {
  const available = new Set(availableMarkers);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const marker of new Set(usedMarkers)) {
    if (available.has(marker)) valid.push(marker);
    else invalid.push(marker);
  }
  return { valid, invalid };
}
