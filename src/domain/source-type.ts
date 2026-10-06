/**
 * Mirrors the `source_type` Postgres enum (db/migrations/0002_knowledge.sql)
 * exactly. Kept here, not inferred from the database, because the one
 * place that must never see an unrecognized value is the INSERT/UPDATE
 * that casts into the enum -- a free-form string from a caller (the
 * dashboard, the Custom GPT guessing "article") must be normalized
 * before it gets anywhere near that cast, or Postgres rejects the whole
 * write with an opaque 500 instead of the source actually being saved.
 */
export const SOURCE_TYPES = [
  'web_article', 'research_paper', 'systematic_review', 'meta_analysis',
  'randomized_controlled_trial', 'cohort_study', 'case_control_study',
  'cross_sectional_study', 'case_report', 'clinical_guideline',
  'government_report', 'policy_document', 'book', 'book_chapter',
  'internal_document', 'uploaded_pdf', 'uploaded_document', 'video',
  'podcast', 'social_post', 'newsletter', 'dataset', 'manual_note', 'other',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

const SOURCE_TYPE_SET = new Set<string>(SOURCE_TYPES);

/**
 * Common words a caller (a human typing into the dashboard, or the
 * Custom GPT guessing at a type) would reach for that aren't themselves
 * valid enum values.
 */
const ALIASES: Record<string, SourceType> = {
  article: 'web_article',
  'news article': 'web_article',
  'news': 'web_article',
  blog: 'web_article',
  'blog post': 'web_article',
  website: 'web_article',
  'web page': 'web_article',
  webpage: 'web_article',
  paper: 'research_paper',
  study: 'research_paper',
  journal: 'research_paper',
  'journal article': 'research_paper',
  review: 'systematic_review',
  'meta analysis': 'meta_analysis',
  rct: 'randomized_controlled_trial',
  trial: 'randomized_controlled_trial',
  'clinical trial': 'randomized_controlled_trial',
  cohort: 'cohort_study',
  'case control': 'case_control_study',
  'cross sectional': 'cross_sectional_study',
  'case report': 'case_report',
  guideline: 'clinical_guideline',
  'clinical guideline': 'clinical_guideline',
  report: 'government_report',
  policy: 'policy_document',
  pdf: 'uploaded_pdf',
  document: 'internal_document',
  doc: 'internal_document',
  file: 'uploaded_document',
  youtube: 'video',
  podcast_episode: 'podcast',
  tweet: 'social_post',
  post: 'social_post',
  'social media': 'social_post',
  newsletter_issue: 'newsletter',
  note: 'manual_note',
  text: 'manual_note',
};

/**
 * Maps any caller-supplied value to a real enum member, never throwing.
 * Exact matches pass straight through; known aliases are translated;
 * anything else -- including nothing at all -- falls back to a safe
 * default rather than ever reaching the database with a bad value.
 */
export function normalizeSourceType(
  value: string | null | undefined,
  fallback: SourceType = 'other',
): SourceType {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (SOURCE_TYPE_SET.has(normalized)) return normalized as SourceType;

  const spaced = normalized.replace(/_/g, ' ');
  if (ALIASES[normalized]) return ALIASES[normalized];
  if (ALIASES[spaced]) return ALIASES[spaced];

  return fallback;
}

export function isSourceType(value: string): value is SourceType {
  return SOURCE_TYPE_SET.has(value);
}
