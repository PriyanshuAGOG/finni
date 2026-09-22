-- =====================================================================
-- Simplify the Nirog Bhoomi knowledge base.
--
-- Data-preserving migration: source records, versions, text, claims,
-- annotations and audit logs stay intact.
-- =====================================================================

UPDATE sources
SET review_status = 'approved'::review_status,
    assigned_reviewer_id = NULL,
    rejection_reason = NULL,
    review_conditions = '[]'::jsonb,
    approved_at = coalesce(approved_at, now()),
    updated_at = now()
WHERE status != 'deleted'
  AND review_status != 'approved'::review_status;

UPDATE organizations
SET settings = coalesce(settings, '{}'::jsonb)
             || '{"allow_ai_category_creation": false, "knowledge_taxonomy_version": 2}'::jsonb;

UPDATE categories
SET status = 'archived'::lifecycle_status,
    archived_at = coalesce(archived_at, now()),
    updated_at = now()
WHERE status = 'active'::lifecycle_status;

INSERT INTO categories (
  organization_id, name, normalized_name, slug, description, status,
  synonyms, ai_usage_guidance, position, created_by, updated_by
)
SELECT
  o.id,
  spec.name,
  spec.normalized_name,
  spec.slug,
  spec.description,
  'active'::lifecycle_status,
  spec.synonyms::jsonb,
  spec.guidance,
  spec.position,
  first_user.id,
  first_user.id
FROM organizations o
CROSS JOIN LATERAL (
  SELECT u.id
  FROM users u
  WHERE u.organization_id = o.id AND u.status = 'active'
  ORDER BY u.created_at
  LIMIT 1
) first_user
CROSS JOIN (
  VALUES
    (
      'Movement, Exercise and Yoga',
      'movement exercise yoga',
      'movement-exercise-yoga',
      'Movement, walking, exercise, fitness, strength, mobility, sports and yoga.',
      '["movement","exercise","physical activity","walking","fitness","strength training","mobility","yoga"]',
      'Use for content primarily about movement, exercise, physical activity, walking, strength, fitness, mobility or yoga.',
      0
    ),
    (
      'Lifestyle',
      'lifestyle',
      'lifestyle',
      'Sleep, stress, habits, routines, recovery, behaviour and broader lifestyle practices.',
      '["sleep","stress","habits","routine","recovery","mindfulness","meditation","behaviour","behavior","hydration"]',
      'Use for content primarily about sleep, stress, habits, routines, recovery, mindfulness, behaviour or broader lifestyle practices.',
      1
    ),
    (
      'Food',
      'food',
      'food',
      'Food, diet, nutrition, meals, nutrients, fasting and dietary patterns.',
      '["food","diet","nutrition","meal","eating","carbohydrate","protein","fat","fibre","fiber","fasting","nutrient"]',
      'Use for content primarily about food, diet, nutrition, meals, nutrients, dietary patterns or fasting.',
      2
    ),
    (
      'Miscellaneous',
      'miscellaneous',
      'miscellaneous',
      'Knowledge that does not clearly belong to movement, lifestyle or food.',
      '["miscellaneous","other","general"]',
      'Fallback category. Use when the source is not clearly about Movement, Exercise and Yoga, Lifestyle, or Food.',
      3
    )
) AS spec(name, normalized_name, slug, description, synonyms, guidance, position)
ON CONFLICT (organization_id, slug)
DO UPDATE SET
  name = EXCLUDED.name,
  normalized_name = EXCLUDED.normalized_name,
  description = EXCLUDED.description,
  status = 'active'::lifecycle_status,
  archived_at = NULL,
  synonyms = EXCLUDED.synonyms,
  ai_usage_guidance = EXCLUDED.ai_usage_guidance,
  position = EXCLUDED.position,
  updated_at = now();

DELETE FROM source_categories;

WITH classified AS (
  SELECT
    s.id AS source_id,
    s.organization_id,
    lower(
      concat_ws(
        ' ',
        coalesce(s.title, ''),
        coalesce(s.abstract, ''),
        coalesce(s.ai_summary_short, ''),
        coalesce(s.ai_summary_detailed, ''),
        left(coalesce(s.normalized_text, ''), 12000)
      )
    ) AS corpus
  FROM sources s
  WHERE s.status != 'deleted'::lifecycle_status
),
chosen AS (
  SELECT
    source_id,
    organization_id,
    CASE
      WHEN corpus ~ '\m(yoga|exercise|exercises|physical activity|walking|walk|workout|fitness|resistance training|strength training|strength|aerobic|cardio|mobility|stretching|movement|steps|sedentary|sport|sports)\M'
        THEN 'movement-exercise-yoga'
      WHEN corpus ~ '\m(food|foods|diet|dietary|nutrition|nutritional|meal|meals|eating|carbohydrate|carbohydrates|protein|proteins|fat|fats|fibre|fiber|glycaemic index|glycemic index|glycaemic load|glycemic load|calorie|calories|nutrient|nutrients|fasting|supplement|supplements)\M'
        THEN 'food'
      WHEN corpus ~ '\m(lifestyle|sleep|stress|meditation|mindfulness|habit|habits|behaviour|behavior|routine|routines|recovery|smoking|alcohol|hydration|water|circadian|adherence|wellbeing|well-being|mental health)\M'
        THEN 'lifestyle'
      ELSE 'miscellaneous'
    END AS category_slug
  FROM classified
)
INSERT INTO source_categories (
  source_id, category_id, assignment_source, confidence, approved, assigned_by
)
SELECT
  chosen.source_id,
  c.id,
  'rule'::assignment_source,
  CASE WHEN chosen.category_slug = 'miscellaneous' THEN 0.500 ELSE 0.850 END,
  true,
  s.added_by
FROM chosen
JOIN sources s ON s.id = chosen.source_id
JOIN categories c
  ON c.organization_id = chosen.organization_id
 AND c.slug = chosen.category_slug
 AND c.status = 'active'::lifecycle_status
ON CONFLICT (source_id, category_id)
DO UPDATE SET
  assignment_source = 'rule'::assignment_source,
  confidence = EXCLUDED.confidence,
  approved = true,
  assigned_by = EXCLUDED.assigned_by;
