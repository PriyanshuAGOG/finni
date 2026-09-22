import type { Sql } from '../lib/db';

export const CANONICAL_KNOWLEDGE_CATEGORIES = [
  {
    slug: 'movement-exercise-yoga',
    name: 'Movement, Exercise and Yoga',
    terms: [
      'yoga', 'exercise', 'physical activity', 'walking', 'walk', 'workout',
      'fitness', 'resistance training', 'strength training', 'strength',
      'aerobic', 'cardio', 'mobility', 'stretching', 'movement', 'steps',
      'sedentary', 'sport', 'sports',
    ],
  },
  {
    slug: 'lifestyle',
    name: 'Lifestyle',
    terms: [
      'lifestyle', 'sleep', 'stress', 'meditation', 'mindfulness', 'habit',
      'habits', 'behaviour', 'behavior', 'routine', 'routines', 'recovery',
      'smoking', 'alcohol', 'hydration', 'water', 'circadian', 'adherence',
      'wellbeing', 'well-being', 'mental health',
    ],
  },
  {
    slug: 'food',
    name: 'Food',
    terms: [
      'food', 'foods', 'diet', 'dietary', 'nutrition', 'nutritional', 'meal',
      'meals', 'eating', 'carbohydrate', 'carbohydrates', 'protein', 'proteins',
      'fat', 'fats', 'fibre', 'fiber', 'glycaemic index', 'glycemic index',
      'glycaemic load', 'glycemic load', 'calorie', 'calories', 'nutrient',
      'nutrients', 'fasting', 'supplement', 'supplements',
    ],
  },
  {
    slug: 'miscellaneous',
    name: 'Miscellaneous',
    terms: [],
  },
] as const;

export type CanonicalKnowledgeCategorySlug =
  (typeof CANONICAL_KNOWLEDGE_CATEGORIES)[number]['slug'];

function occurrences(text: string, term: string): number {
  if (!term) return 0;
  const escaped = term.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(`\\b${escaped}\\b`, 'gi'));
  return matches?.length ?? 0;
}

/**
 * Deterministic first-pass classifier used synchronously during ingestion.
 * Title matches count more heavily than body matches. The async AI classifier
 * may refine the choice later, but is constrained to these same four buckets.
 */
export function classifyKnowledgeCategory(
  title: string,
  text: string,
): { slug: CanonicalKnowledgeCategorySlug; name: string; confidence: number } {
  const normalizedTitle = title.toLowerCase();
  const normalizedBody = text.toLowerCase().slice(0, 30000);

  let winner: { slug: CanonicalKnowledgeCategorySlug; name: string; score: number } = {
    slug: 'miscellaneous',
    name: 'Miscellaneous',
    score: 0,
  };

  for (const category of CANONICAL_KNOWLEDGE_CATEGORIES) {
    if (category.slug === 'miscellaneous') continue;
    let score = 0;
    for (const term of category.terms) {
      score += occurrences(normalizedTitle, term) * 5;
      score += Math.min(occurrences(normalizedBody, term), 6);
    }
    if (score > winner.score) {
      winner = { slug: category.slug, name: category.name, score };
    }
  }

  if (winner.score === 0) {
    return { slug: 'miscellaneous', name: 'Miscellaneous', confidence: 0.5 };
  }

  return {
    slug: winner.slug,
    name: winner.name,
    confidence: Math.min(0.95, 0.62 + winner.score * 0.025),
  };
}

export async function assignCanonicalKnowledgeCategory(
  sql: Sql,
  sourceId: string,
  title: string,
  text: string,
  options: {
    assignmentSource?: 'human' | 'ai' | 'import' | 'rule' | 'custom_gpt';
    assignedBy?: string | null;
  } = {},
): Promise<{ id: string; slug: CanonicalKnowledgeCategorySlug; name: string; confidence: number } | null> {
  const choice = classifyKnowledgeCategory(title, text);
  const category =
    (await sql.one<{ id: string; slug: CanonicalKnowledgeCategorySlug; name: string }>(
      `SELECT id, slug, name
       FROM categories
       WHERE status = 'active' AND slug = $1
       LIMIT 1`,
      [choice.slug],
    )) ??
    (await sql.one<{ id: string; slug: CanonicalKnowledgeCategorySlug; name: string }>(
      `SELECT id, slug, name
       FROM categories
       WHERE status = 'active' AND slug = 'miscellaneous'
       LIMIT 1`,
    ));

  if (!category) return null;

  await sql.query(`DELETE FROM source_categories WHERE source_id = $1`, [sourceId]);
  await sql.query(
    `INSERT INTO source_categories (
       source_id, category_id, assignment_source, confidence, approved, assigned_by
     ) VALUES ($1,$2,$3::assignment_source,$4,true,$5)`,
    [
      sourceId,
      category.id,
      options.assignmentSource ?? 'rule',
      choice.confidence,
      options.assignedBy ?? null,
    ],
  );

  return { ...category, confidence: choice.confidence };
}
