import { z } from 'zod';

/**
 * Every AI stage returns structured output validated against one of these
 * schemas. Nothing downstream ever consumes free-form model text, so a
 * malformed or manipulated response fails loudly at the boundary instead
 * of quietly contaminating a record.
 */

const confidence = z.number().min(0).max(1);

/** Models must say "unknown" rather than invent a value. */
const unknownable = <T extends z.ZodTypeAny>(inner: T) => inner.nullable();

// ---------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------

export const MetadataExtractionSchema = z.object({
  title: unknownable(z.string()),
  subtitle: unknownable(z.string()),
  authors: z.array(z.string()).default([]),
  publisher: unknownable(z.string()),
  journal: unknownable(z.string()),
  publication_date: unknownable(z.string()),
  source_type: z.enum([
    'web_article', 'research_paper', 'systematic_review', 'meta_analysis',
    'randomized_controlled_trial', 'cohort_study', 'case_control_study',
    'cross_sectional_study', 'case_report', 'clinical_guideline',
    'government_report', 'policy_document', 'book', 'book_chapter',
    'internal_document', 'uploaded_pdf', 'uploaded_document', 'video',
    'podcast', 'social_post', 'newsletter', 'dataset', 'manual_note', 'other',
  ]),
  language: unknownable(z.string()),
  country: unknownable(z.string()),
  doi: unknownable(z.string()),
  pmid: unknownable(z.string()),
  abstract: unknownable(z.string()),
  funding_information: unknownable(z.string()),
  conflicts_of_interest: unknownable(z.string()),
  retraction_indicators: z.array(z.string()).default([]),
  confidence,
});
export type MetadataExtraction = z.infer<typeof MetadataExtractionSchema>;

// ---------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------

export const SummarySchema = z.object({
  one_sentence: z.string(),
  short: z.string(),
  detailed: z.string(),
  key_findings: z.array(z.string()).default([]),
  practical_implications: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  safety_implications: z.array(z.string()).default([]),
  questions_requiring_review: z.array(z.string()).default([]),
  confidence,
});
export type Summary = z.infer<typeof SummarySchema>;

// ---------------------------------------------------------------------
// Taxonomy classification
// ---------------------------------------------------------------------

export const ClassificationSchema = z.object({
  categories: z
    .array(
      z.object({
        category_id: z.string(),
        name: z.string(),
        confidence,
        rationale: z.string().optional(),
      }),
    )
    .default([]),
  tags: z.array(z.object({ name: z.string(), confidence })).default([]),
  /**
   * Proposals only. Nothing here is created unless organization settings
   * explicitly allow AI-created taxonomy.
   */
  proposed_new_categories: z
    .array(
      z.object({
        name: z.string(),
        suggested_parent_id: z.string().nullable(),
        rationale: z.string(),
        similar_existing: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  recommended_collection_ids: z.array(z.string()).default([]),
  confidence,
});
export type Classification = z.infer<typeof ClassificationSchema>;

// ---------------------------------------------------------------------
// Study extraction
// ---------------------------------------------------------------------

const studyField = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner.nullable(),
    confidence,
    /** Verbatim text the value was taken from, for traceability. */
    evidence_excerpt: z.string().nullable(),
    locator: z.string().nullable(),
  });

export const StudyExtractionSchema = z.object({
  is_study: z.boolean(),
  study_design: studyField(z.string()),
  registration_identifier: studyField(z.string()),
  sample_size: studyField(z.number().int()),
  population_description: studyField(z.string()),
  inclusion_criteria: studyField(z.array(z.string())),
  exclusion_criteria: studyField(z.array(z.string())),
  age_range: studyField(z.string()),
  sex_distribution: studyField(z.string()),
  geography: studyField(z.string()),
  setting: studyField(z.string()),
  intervention: studyField(z.string()),
  comparator: studyField(z.string()),
  duration: studyField(z.string()),
  follow_up_duration: studyField(z.string()),
  primary_outcomes: studyField(z.array(z.string())),
  secondary_outcomes: studyField(z.array(z.string())),
  effect_sizes: studyField(z.array(z.string())),
  confidence_intervals: studyField(z.array(z.string())),
  p_values: studyField(z.array(z.string())),
  attrition_rate: studyField(z.string()),
  adverse_events: studyField(z.array(z.string())),
  statistical_methods: studyField(z.string()),
  funding_source: studyField(z.string()),
  conflicts_of_interest: studyField(z.string()),
  limitations: studyField(z.array(z.string())),
  risk_of_bias: studyField(z.string()),
  pico_population: studyField(z.string()),
  pico_intervention: studyField(z.string()),
  pico_comparator: studyField(z.string()),
  pico_outcomes: studyField(z.array(z.string())),
  overall_confidence: confidence,
});
export type StudyExtraction = z.infer<typeof StudyExtractionSchema>;

// ---------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------

export const ClaimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        canonical_text: z.string(),
        simplified_text: z.string(),
        population: z.string().nullable(),
        intervention: z.string().nullable(),
        comparator: z.string().nullable(),
        outcome: z.string().nullable(),
        timeframe: z.string().nullable(),
        qualifiers: z.array(z.string()).default([]),
        quantitative_value: z.string().nullable(),
        units: z.string().nullable(),
        source_excerpt: z.string(),
        locator: z.string().nullable(),
        /**
         * Distinguishes what the source found from what it merely cited,
         * opined or recommended. Collapsing these is how an author's
         * aside becomes an organizational fact.
         */
        claim_nature: z.enum([
          'source_finding',
          'cited_background_claim',
          'author_opinion',
          'recommendation',
        ]),
        safety_relevant: z.boolean().default(false),
        extraction_confidence: confidence,
      }),
    )
    .default([]),
});
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;

// ---------------------------------------------------------------------
// Contradiction analysis
// ---------------------------------------------------------------------

export const ContradictionAnalysisSchema = z.object({
  assessments: z
    .array(
      z.object({
        other_claim_id: z.string().nullable(),
        other_source_id: z.string().nullable(),
        /**
         * A genuine disagreement is rarer than it looks. Most apparent
         * conflicts are different populations, doses or endpoints, and
         * labelling those as contradictions destroys trust in the flag.
         */
        classification: z.enum([
          'true_contradiction',
          'different_population',
          'different_intervention_intensity',
          'different_outcome_definition',
          'different_time_horizon',
          'added_qualification',
          'methodological_disagreement',
          'not_in_conflict',
        ]),
        dimensions_compared: z.array(z.string()).default([]),
        explanation: z.string(),
        confidence,
        /** Always a suggestion for a reviewer, never a settled verdict. */
        requires_human_review: z.boolean().default(true),
      }),
    )
    .default([]),
});
export type ContradictionAnalysis = z.infer<typeof ContradictionAnalysisSchema>;

// ---------------------------------------------------------------------
// Evidence assessment
// ---------------------------------------------------------------------

const grade = z.enum(['very_low', 'low', 'moderate', 'high', 'very_high', 'unknown']);

export const EvidenceAssessmentSchema = z.object({
  study_design_strength: grade,
  source_authority: grade,
  sample_adequacy: grade,
  directness: grade,
  consistency: grade,
  precision: grade,
  recency: grade,
  population_relevance: grade,
  conflict_of_interest_risk: z.enum(['none_apparent', 'low', 'moderate', 'high', 'unknown']),
  overall_confidence: grade,
  rationale: z.string(),
});
export type EvidenceAssessment = z.infer<typeof EvidenceAssessmentSchema>;

// ---------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------

export const SynthesisSchema = z.object({
  answer: z.string(),
  main_findings: z
    .array(z.object({ statement: z.string(), citation_markers: z.array(z.string()) }))
    .default([]),
  contradictions: z
    .array(z.object({ description: z.string(), citation_markers: z.array(z.string()) }))
    .default([]),
  limitations: z.array(z.string()).default([]),
  safety_notes: z.array(z.string()).default([]),
  evidence_quality: z.string(),
  gaps: z.array(z.string()).default([]),
  /** Markers used in the answer; validated against the retrieval context. */
  used_citation_markers: z.array(z.string()).default([]),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

// ---------------------------------------------------------------------
// Query understanding
// ---------------------------------------------------------------------

export const QueryUnderstandingSchema = z.object({
  semantic_query: z.string(),
  keywords: z.array(z.string()).default([]),
  synonyms: z.array(z.string()).default([]),
  population: z.string().nullable(),
  intervention: z.string().nullable(),
  comparator: z.string().nullable(),
  outcome: z.string().nullable(),
  study_designs: z.array(z.string()).default([]),
  source_types: z.array(z.string()).default([]),
  published_after: z.string().nullable(),
  published_before: z.string().nullable(),
  geography: z.array(z.string()).default([]),
  requested_output: z.enum(['sources', 'answer', 'evidence', 'comparison', 'brief', 'claims']),
});
export type QueryUnderstanding = z.infer<typeof QueryUnderstandingSchema>;

// ---------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------

export const GeneratedContentSchema = z.object({
  title: z.string(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        body: z.string(),
        citation_markers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Statements the model could not tie to a retrieved passage. */
  unsupported_claims: z.array(z.string()).default([]),
  safety_flags: z.array(z.string()).default([]),
});
export type GeneratedContentOutput = z.infer<typeof GeneratedContentSchema>;

export const BriefSectionSchema = z.object({
  sections: z.record(z.string(), z.string()),
  citation_markers: z.array(z.string()).default([]),
});
export type BriefSectionOutput = z.infer<typeof BriefSectionSchema>;
