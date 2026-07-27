import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { ApiError, conflict, invalidInput, notFound } from '../lib/errors';
import { normalizeTaxonomyName, slugify } from '../lib/text';
import { recordAudit } from './audit';
import { guardConfirmation } from './confirmation';

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_category_id: string | null;
  status: string;
  color: string | null;
  icon: string | null;
  synonyms: string[];
  ai_usage_guidance: string | null;
  created_at: string;
  updated_at: string;
  usage_count?: number;
  dashboard_url?: string;
}

export interface CategoryNode extends Category {
  children: CategoryNode[];
}

function dashboardUrl(path: string): string {
  return path;
}

// ---------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------

export async function listCategories(
  ctx: ActorContext,
  options: {
    query?: string;
    parentId?: string | null;
    includeArchived?: boolean;
    includeUsageCounts?: boolean;
    tree?: boolean;
  } = {},
): Promise<{ categories: Category[]; tree?: CategoryNode[] }> {
  requirePermission(ctx, 'taxonomy.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [options.includeArchived ? '1=1' : `c.status = 'active'`];

    if (options.query) {
      where.push(`(c.normalized_name % ${add(normalizeTaxonomyName(options.query))}
                   OR lower(c.name) LIKE ${add(`%${options.query.toLowerCase()}%`)})`);
    }
    if (options.parentId !== undefined) {
      where.push(
        options.parentId === null
          ? 'c.parent_category_id IS NULL'
          : `c.parent_category_id = ${add(options.parentId)}`,
      );
    }

    const usageSelect = options.includeUsageCounts
      ? `, (SELECT count(*) FROM source_categories sc
            JOIN sources s ON s.id = sc.source_id
            WHERE sc.category_id = c.id AND s.status = 'active')::int AS usage_count`
      : '';

    const rows = await sql.query<Category>(
      `SELECT c.id, c.name, c.slug, c.description, c.parent_category_id, c.status,
              c.color, c.icon, c.synonyms, c.ai_usage_guidance, c.created_at, c.updated_at
              ${usageSelect}
       FROM categories c
       WHERE ${where.join(' AND ')}
       ORDER BY c.position, c.name`,
      params,
    );

    const categories = rows.map((c) => ({ ...c, dashboard_url: dashboardUrl(`/categories/${c.id}`) }));
    if (!options.tree) return { categories };
    return { categories, tree: buildTree(categories) };
  });
}

function buildTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) nodes.set(category.id, { ...category, children: [] });

  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_category_id ? nodes.get(node.parent_category_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface SimilarCategory {
  id: string;
  name: string;
  parent_category_id: string | null;
  parent_name: string | null;
  similarity: number;
  match_reason: string;
  usage_count: number;
  dashboard_url: string;
}

/**
 * Finds categories that would overlap with a proposed name.
 *
 * Duplicate taxonomy is cheap to create and expensive to unwind, so this
 * runs before any creation. It compares normalized names (which collapse
 * case, punctuation, plurals and filler words) and declared synonyms, not
 * just the literal string.
 */
export async function findSimilarCategories(
  ctx: ActorContext,
  input: { name: string; parentCategoryId?: string | null; limit?: number },
): Promise<SimilarCategory[]> {
  requirePermission(ctx, 'taxonomy.read');
  const normalized = normalizeTaxonomyName(input.name);
  if (!normalized) throw invalidInput('A category name is required.');

  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<{
      id: string;
      name: string;
      parent_category_id: string | null;
      parent_name: string | null;
      normalized_name: string;
      synonyms: string[];
      similarity: number;
      usage_count: number;
    }>(
      `SELECT c.id, c.name, c.parent_category_id, p.name AS parent_name,
              c.normalized_name, c.synonyms,
              similarity(c.normalized_name, $1) AS similarity,
              (SELECT count(*) FROM source_categories sc WHERE sc.category_id = c.id)::int AS usage_count
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_category_id
       WHERE c.status = 'active'
         AND (c.normalized_name % $1
              OR c.normalized_name = $1
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(c.synonyms) syn
                WHERE lower(syn) = lower($2)
              ))
       ORDER BY similarity DESC
       LIMIT $3`,
      [normalized, input.name, input.limit ?? 10],
    );

    return rows.map((row) => {
      const exact = row.normalized_name === normalized;
      const sameParent =
        (row.parent_category_id ?? null) === (input.parentCategoryId ?? null);
      const synonymMatch = (row.synonyms ?? []).some(
        (s) => normalizeTaxonomyName(s) === normalized,
      );

      return {
        id: row.id,
        name: row.name,
        parent_category_id: row.parent_category_id,
        parent_name: row.parent_name,
        // An exact normalized match under the same parent is a duplicate,
        // not merely a similar name.
        similarity: exact ? (sameParent ? 1 : 0.95) : synonymMatch ? 0.9 : Number(row.similarity),
        match_reason: exact
          ? sameParent
            ? 'Identical name under the same parent category'
            : 'Identical name under a different parent category'
          : synonymMatch
            ? 'Listed as a synonym of this category'
            : 'Similar name',
        usage_count: row.usage_count,
        dashboard_url: dashboardUrl(`/categories/${row.id}`),
      };
    });
  });
}

export async function createCategory(
  ctx: ActorContext,
  input: {
    name: string;
    description?: string | null;
    parentCategoryId?: string | null;
    synonyms?: string[];
    color?: string | null;
    icon?: string | null;
    aiUsageGuidance?: string | null;
    /** Set only when the user has been shown the duplicates and chose to proceed. */
    allowDuplicate?: boolean;
  },
): Promise<Category> {
  requirePermission(ctx, 'taxonomy.create');

  const name = input.name.trim();
  if (!name) throw invalidInput('A category name is required.');
  const normalized = normalizeTaxonomyName(name);
  if (!normalized) {
    throw invalidInput('The category name must contain at least one meaningful word.');
  }

  if (!input.allowDuplicate) {
    const similar = await findSimilarCategories(ctx, {
      name,
      parentCategoryId: input.parentCategoryId ?? null,
    });
    const blocking = similar.filter((s) => s.similarity >= 0.9);
    if (blocking.length > 0) {
      throw new ApiError(
        'CONFLICT',
        `A category equivalent to "${name}" already exists.`,
        {
          details: {
            existing_categories: blocking,
            reason: 'duplicate_taxonomy',
          },
          suggestedAction:
            'Use the existing category. If a genuinely distinct category is intended, retry with allow_duplicate set to true and explain the distinction in the description.',
        },
      );
    }
  }

  return withOrg(ctx.organizationId, async (sql) => {
    if (input.parentCategoryId) {
      const parent = await sql.one(`SELECT id FROM categories WHERE id = $1 AND status = 'active'`, [
        input.parentCategoryId,
      ]);
      if (!parent) throw notFound('parent category', input.parentCategoryId);
    }

    const slug = await uniqueSlug(sql, 'categories', slugify(name));

    let row: Category | null;
    try {
      row = await sql.one<Category>(
        `INSERT INTO categories (
           organization_id, name, normalized_name, slug, description,
           parent_category_id, synonyms, color, icon, ai_usage_guidance,
           created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING id, name, slug, description, parent_category_id, status,
                   color, icon, synonyms, ai_usage_guidance, created_at, updated_at`,
        [
          ctx.organizationId,
          name,
          normalized,
          slug,
          input.description ?? null,
          input.parentCategoryId ?? null,
          JSON.stringify(input.synonyms ?? []),
          input.color ?? null,
          input.icon ?? null,
          input.aiUsageGuidance ?? null,
          ctx.userId,
        ],
      );
    } catch (err) {
      // The partial unique indexes are the last line of defence against a
      // duplicate created by two concurrent requests.
      if (isUniqueViolation(err)) {
        throw conflict(`A sibling category named "${name}" already exists.`, { name });
      }
      throw err;
    }

    await recordAudit(sql, ctx, {
      action: 'category.created',
      resourceType: 'category',
      resourceId: row!.id,
      newState: { name, parent_category_id: input.parentCategoryId ?? null },
    });

    return { ...row!, dashboard_url: dashboardUrl(`/categories/${row!.id}`) };
  });
}

export async function updateCategory(
  ctx: ActorContext,
  categoryId: string,
  updates: {
    name?: string;
    description?: string | null;
    synonyms?: string[];
    color?: string | null;
    icon?: string | null;
    aiUsageGuidance?: string | null;
  },
): Promise<Category> {
  requirePermission(ctx, 'taxonomy.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Category & { normalized_name: string }>(
      `SELECT * FROM categories WHERE id = $1`,
      [categoryId],
    );
    if (!existing) throw notFound('category', categoryId);

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];

    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) throw invalidInput('A category name cannot be empty.');
      sets.push(`name = ${add(name)}`, `normalized_name = ${add(normalizeTaxonomyName(name))}`);
    }
    if (updates.description !== undefined) sets.push(`description = ${add(updates.description)}`);
    if (updates.synonyms !== undefined) {
      sets.push(`synonyms = ${add(JSON.stringify(updates.synonyms))}`);
    }
    if (updates.color !== undefined) sets.push(`color = ${add(updates.color)}`);
    if (updates.icon !== undefined) sets.push(`icon = ${add(updates.icon)}`);
    if (updates.aiUsageGuidance !== undefined) {
      sets.push(`ai_usage_guidance = ${add(updates.aiUsageGuidance)}`);
    }

    if (sets.length === 0) return existing;
    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()');

    const row = await sql.one<Category>(
      `UPDATE categories SET ${sets.join(', ')} WHERE id = ${add(categoryId)}
       RETURNING id, name, slug, description, parent_category_id, status,
                 color, icon, synonyms, ai_usage_guidance, created_at, updated_at`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'category.updated',
      resourceType: 'category',
      resourceId: categoryId,
      previousState: {
        name: existing.name,
        description: existing.description,
        synonyms: existing.synonyms,
      },
      newState: { name: row!.name, description: row!.description, synonyms: row!.synonyms },
    });

    return { ...row!, dashboard_url: dashboardUrl(`/categories/${categoryId}`) };
  });
}

export async function moveCategory(
  ctx: ActorContext,
  categoryId: string,
  newParentCategoryId: string | null,
): Promise<Category> {
  requirePermission(ctx, 'taxonomy.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Category>(`SELECT * FROM categories WHERE id = $1`, [categoryId]);
    if (!existing) throw notFound('category', categoryId);

    if (newParentCategoryId) {
      if (newParentCategoryId === categoryId) {
        throw invalidInput('A category cannot be its own parent.');
      }
      const parent = await sql.one(`SELECT id FROM categories WHERE id = $1 AND status = 'active'`, [
        newParentCategoryId,
      ]);
      if (!parent) throw notFound('parent category', newParentCategoryId);

      // Walking up from the proposed parent must never reach this
      // category, or the hierarchy becomes a cycle and every tree walk
      // hangs.
      const ancestors = await sql.query<{ id: string }>(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_category_id FROM categories WHERE id = $1
           UNION ALL
           SELECT c.id, c.parent_category_id
           FROM categories c JOIN chain ON c.id = chain.parent_category_id
         )
         SELECT id FROM chain`,
        [newParentCategoryId],
      );
      if (ancestors.some((a) => a.id === categoryId)) {
        throw conflict(
          'That move would create a circular hierarchy: the proposed parent is a descendant of this category.',
          { category_id: categoryId, proposed_parent_id: newParentCategoryId },
        );
      }
    }

    const row = await sql.one<Category>(
      `UPDATE categories SET parent_category_id = $1, updated_by = $2, updated_at = now()
       WHERE id = $3
       RETURNING id, name, slug, description, parent_category_id, status,
                 color, icon, synonyms, ai_usage_guidance, created_at, updated_at`,
      [newParentCategoryId, ctx.userId, categoryId],
    );

    await recordAudit(sql, ctx, {
      action: 'category.moved',
      resourceType: 'category',
      resourceId: categoryId,
      previousState: { parent_category_id: existing.parent_category_id },
      newState: { parent_category_id: newParentCategoryId },
    });

    return { ...row!, dashboard_url: dashboardUrl(`/categories/${categoryId}`) };
  });
}

export interface MergePreview {
  target: { id: string; name: string };
  sources: Array<{ id: string; name: string; source_count: number; child_count: number }>;
  sources_to_move: number;
  children_to_reparent: number;
  synonyms_to_add: string[];
}

export async function previewCategoryMerge(
  ctx: ActorContext,
  input: { sourceCategoryIds: string[]; targetCategoryId: string },
): Promise<MergePreview> {
  requirePermission(ctx, 'taxonomy.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string; name: string }>(
      `SELECT id, name FROM categories WHERE id = $1 AND status = 'active'`,
      [input.targetCategoryId],
    );
    if (!target) throw notFound('target category', input.targetCategoryId);

    if (input.sourceCategoryIds.includes(input.targetCategoryId)) {
      throw invalidInput('The target category cannot also be one of the categories being merged.');
    }

    const rows = await sql.query<{
      id: string;
      name: string;
      source_count: number;
      child_count: number;
    }>(
      `SELECT c.id, c.name,
              (SELECT count(*) FROM source_categories sc WHERE sc.category_id = c.id)::int AS source_count,
              (SELECT count(*) FROM categories ch WHERE ch.parent_category_id = c.id AND ch.status = 'active')::int AS child_count
       FROM categories c
       WHERE c.id = ANY($1::uuid[]) AND c.status = 'active'`,
      [input.sourceCategoryIds],
    );

    const missing = input.sourceCategoryIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) {
      throw notFound('category', missing[0]);
    }

    return {
      target,
      sources: rows,
      sources_to_move: rows.reduce((sum, r) => sum + r.source_count, 0),
      children_to_reparent: rows.reduce((sum, r) => sum + r.child_count, 0),
      synonyms_to_add: rows.map((r) => r.name),
    };
  });
}

export async function mergeCategories(
  ctx: ActorContext,
  input: {
    sourceCategoryIds: string[];
    targetCategoryId: string;
    preserveSourceNamesAsSynonyms?: boolean;
    confirmationId?: string | null;
  },
): Promise<{ merged: number; sources_moved: number; children_reparented: number; target: Category }> {
  requirePermission(ctx, 'taxonomy.merge');

  const preview = await previewCategoryMerge(ctx, input);

  return withOrg(ctx.organizationId, async (sql) => {
    const confirmationId = await guardConfirmation(sql, ctx, {
      actionType: 'mergeCategories',
      resourceType: 'category',
      resourceIds: [...input.sourceCategoryIds].sort(),
      actionPayload: {
        target_category_id: input.targetCategoryId,
        preserve_source_names_as_synonyms: input.preserveSourceNamesAsSynonyms ?? true,
      },
      humanSummary: `Merge ${preview.sources.map((s) => `"${s.name}"`).join(', ')} into "${preview.target.name}". ${preview.sources_to_move} source assignment(s) and ${preview.children_to_reparent} child category/categories will move. The merged categories will be archived.`,
      confirmationId: input.confirmationId,
    });

    const parentAuditId = await recordAudit(sql, ctx, {
      action: 'category.merge_started',
      resourceType: 'category',
      resourceId: input.targetCategoryId,
      newState: {
        source_category_ids: input.sourceCategoryIds,
        target_category_id: input.targetCategoryId,
      },
      confirmationId,
    });

    // Reassign source memberships, skipping any that would duplicate an
    // assignment the target already has.
    const moved = await sql.query<{ source_id: string }>(
      `INSERT INTO source_categories (source_id, category_id, assignment_source, confidence, approved, assigned_by)
       SELECT sc.source_id, $1, sc.assignment_source, sc.confidence, sc.approved, sc.assigned_by
       FROM source_categories sc
       WHERE sc.category_id = ANY($2::uuid[])
       ON CONFLICT (source_id, category_id) DO NOTHING
       RETURNING source_id`,
      [input.targetCategoryId, input.sourceCategoryIds],
    );

    await sql.query(`DELETE FROM source_categories WHERE category_id = ANY($1::uuid[])`, [
      input.sourceCategoryIds,
    ]);

    await sql.query(
      `INSERT INTO claim_categories (claim_id, category_id)
       SELECT cc.claim_id, $1 FROM claim_categories cc
       WHERE cc.category_id = ANY($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [input.targetCategoryId, input.sourceCategoryIds],
    );
    await sql.query(`DELETE FROM claim_categories WHERE category_id = ANY($1::uuid[])`, [
      input.sourceCategoryIds,
    ]);

    const reparented = await sql.query<{ id: string }>(
      `UPDATE categories SET parent_category_id = $1, updated_at = now()
       WHERE parent_category_id = ANY($2::uuid[]) AND status = 'active'
       RETURNING id`,
      [input.targetCategoryId, input.sourceCategoryIds],
    );

    // Keeping the old names as synonyms means future searches and
    // classifications still find the target under the merged-away names.
    if (input.preserveSourceNamesAsSynonyms !== false) {
      await sql.query(
        `UPDATE categories
         SET synonyms = (
           SELECT jsonb_agg(DISTINCT value)
           FROM jsonb_array_elements_text(synonyms || $1::jsonb) AS t(value)
         ), updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(preview.synonyms_to_add), input.targetCategoryId],
      );
    }

    await sql.query(
      `UPDATE categories
       SET status = 'merged', merged_into_category_id = $1,
           archived_at = now(), archived_by = $2, updated_at = now()
       WHERE id = ANY($3::uuid[])`,
      [input.targetCategoryId, ctx.userId, input.sourceCategoryIds],
    );

    for (const source of preview.sources) {
      await recordAudit(sql, ctx, {
        action: 'category.merged',
        resourceType: 'category',
        resourceId: source.id,
        parentAuditId,
        previousState: { status: 'active', name: source.name },
        newState: { status: 'merged', merged_into_category_id: input.targetCategoryId },
        confirmationId,
      });
    }

    const target = await sql.one<Category>(
      `SELECT id, name, slug, description, parent_category_id, status, color, icon,
              synonyms, ai_usage_guidance, created_at, updated_at
       FROM categories WHERE id = $1`,
      [input.targetCategoryId],
    );

    return {
      merged: input.sourceCategoryIds.length,
      sources_moved: moved.length,
      children_reparented: reparented.length,
      target: { ...target!, dashboard_url: dashboardUrl(`/categories/${input.targetCategoryId}`) },
    };
  });
}

export async function archiveCategory(
  ctx: ActorContext,
  categoryId: string,
  confirmationId?: string | null,
): Promise<Category> {
  requirePermission(ctx, 'taxonomy.archive');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Category & { usage_count: number; child_count: number }>(
      `SELECT c.*,
              (SELECT count(*) FROM source_categories sc WHERE sc.category_id = c.id)::int AS usage_count,
              (SELECT count(*) FROM categories ch WHERE ch.parent_category_id = c.id AND ch.status = 'active')::int AS child_count
       FROM categories c WHERE c.id = $1`,
      [categoryId],
    );
    if (!existing) throw notFound('category', categoryId);
    if (existing.status !== 'active') {
      throw conflict(`This category is already ${existing.status}.`);
    }
    if (existing.child_count > 0) {
      throw conflict(
        `This category has ${existing.child_count} active child categor${existing.child_count === 1 ? 'y' : 'ies'}. Move or archive them first.`,
        { child_count: existing.child_count },
      );
    }

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'archiveCategory',
      resourceType: 'category',
      resourceIds: [categoryId],
      actionPayload: {},
      humanSummary: `Archive the category "${existing.name}", which is currently assigned to ${existing.usage_count} source(s). The assignments are kept and the category can be restored.`,
      confirmationId,
      riskContext: { usageCount: existing.usage_count },
    });

    const row = await sql.one<Category>(
      `UPDATE categories
       SET status = 'archived', archived_at = now(), archived_by = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, name, slug, description, parent_category_id, status, color,
                 icon, synonyms, ai_usage_guidance, created_at, updated_at`,
      [ctx.userId, categoryId],
    );

    await recordAudit(sql, ctx, {
      action: 'category.archived',
      resourceType: 'category',
      resourceId: categoryId,
      previousState: { status: 'active' },
      newState: { status: 'archived' },
      confirmationId: usedConfirmation,
    });

    return { ...row!, dashboard_url: dashboardUrl(`/categories/${categoryId}`) };
  });
}

export async function restoreCategory(ctx: ActorContext, categoryId: string): Promise<Category> {
  requirePermission(ctx, 'taxonomy.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Category>(`SELECT * FROM categories WHERE id = $1`, [categoryId]);
    if (!existing) throw notFound('category', categoryId);
    if (existing.status === 'active') throw conflict('This category is already active.');
    if (existing.status === 'merged') {
      throw conflict(
        'This category was merged into another. Restoring it would recreate the duplicate that the merge resolved.',
        { merged: true },
      );
    }

    const row = await sql.one<Category>(
      `UPDATE categories
       SET status = 'active', archived_at = NULL, archived_by = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, name, slug, description, parent_category_id, status, color,
                 icon, synonyms, ai_usage_guidance, created_at, updated_at`,
      [categoryId],
    );

    await recordAudit(sql, ctx, {
      action: 'category.restored',
      resourceType: 'category',
      resourceId: categoryId,
      previousState: { status: existing.status },
      newState: { status: 'active' },
    });

    return { ...row!, dashboard_url: dashboardUrl(`/categories/${categoryId}`) };
  });
}

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------

export interface Tag {
  id: string;
  name: string;
  normalized_name: string;
  description: string | null;
  usage_count: number;
  status: string;
  created_at: string;
}

export async function listTags(
  ctx: ActorContext,
  options: { query?: string; limit?: number; includeArchived?: boolean } = {},
): Promise<Tag[]> {
  requirePermission(ctx, 'taxonomy.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where = [options.includeArchived ? '1=1' : `status = 'active'`];
    if (options.query) {
      where.push(`normalized_name % ${add(normalizeTaxonomyName(options.query))}`);
    }
    return sql.query<Tag>(
      `SELECT id, name, normalized_name, description, usage_count, status, created_at
       FROM tags WHERE ${where.join(' AND ')}
       ORDER BY usage_count DESC, name
       LIMIT ${add(Math.min(options.limit ?? 100, 500))}`,
      params,
    );
  });
}

export async function createTag(
  ctx: ActorContext,
  input: { name: string; description?: string | null },
): Promise<Tag> {
  requirePermission(ctx, 'taxonomy.create');
  const name = input.name.trim();
  if (!name) throw invalidInput('A tag name is required.');

  return withOrg(ctx.organizationId, (sql) => upsertTag(sql, ctx, name, input.description ?? null));
}

/**
 * Tags are created on demand during ingestion, so this returns the
 * existing tag rather than failing when the name is already taken.
 */
export async function upsertTag(
  sql: Sql,
  ctx: ActorContext,
  name: string,
  description: string | null = null,
): Promise<Tag> {
  const normalized = normalizeTaxonomyName(name) || name.toLowerCase().trim();

  const existing = await sql.one<Tag>(
    `SELECT id, name, normalized_name, description, usage_count, status, created_at
     FROM tags WHERE normalized_name = $1`,
    [normalized],
  );
  if (existing) return existing;

  const row = await sql.one<Tag>(
    `INSERT INTO tags (organization_id, name, normalized_name, description, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, normalized_name) DO UPDATE SET updated_at = now()
     RETURNING id, name, normalized_name, description, usage_count, status, created_at`,
    [ctx.organizationId, name.trim(), normalized, description, ctx.userId],
  );

  await recordAudit(sql, ctx, {
    action: 'tag.created',
    resourceType: 'tag',
    resourceId: row!.id,
    newState: { name: row!.name },
  });

  return row!;
}

export async function mergeTags(
  ctx: ActorContext,
  input: { sourceTagIds: string[]; targetTagId: string; confirmationId?: string | null },
): Promise<{ merged: number; assignments_moved: number }> {
  requirePermission(ctx, 'taxonomy.merge');

  return withOrg(ctx.organizationId, async (sql) => {
    const target = await sql.one<{ id: string; name: string }>(
      `SELECT id, name FROM tags WHERE id = $1 AND status = 'active'`,
      [input.targetTagId],
    );
    if (!target) throw notFound('target tag', input.targetTagId);
    if (input.sourceTagIds.includes(input.targetTagId)) {
      throw invalidInput('The target tag cannot also be one of the tags being merged.');
    }

    const sources = await sql.query<{ id: string; name: string; usage_count: number }>(
      `SELECT id, name, usage_count FROM tags WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [input.sourceTagIds],
    );
    const affected = sources.reduce((sum, s) => sum + s.usage_count, 0);

    const confirmationId = await guardConfirmation(sql, ctx, {
      actionType: 'mergeTags',
      resourceType: 'tag',
      resourceIds: [...input.sourceTagIds].sort(),
      actionPayload: { target_tag_id: input.targetTagId },
      humanSummary: `Merge ${sources.map((s) => `"${s.name}"`).join(', ')} into "${target.name}", moving ${affected} assignment(s).`,
      confirmationId: input.confirmationId,
      riskContext: { affectedCount: affected },
    });

    const moved = await sql.query<{ source_id: string }>(
      `INSERT INTO source_tags (source_id, tag_id, assignment_source, confidence, created_by)
       SELECT st.source_id, $1, st.assignment_source, st.confidence, st.created_by
       FROM source_tags st WHERE st.tag_id = ANY($2::uuid[])
       ON CONFLICT (source_id, tag_id) DO NOTHING
       RETURNING source_id`,
      [input.targetTagId, input.sourceTagIds],
    );

    await sql.query(`DELETE FROM source_tags WHERE tag_id = ANY($1::uuid[])`, [input.sourceTagIds]);
    await sql.query(
      `UPDATE tags SET status = 'merged', merged_into_tag_id = $1, updated_at = now()
       WHERE id = ANY($2::uuid[])`,
      [input.targetTagId, input.sourceTagIds],
    );
    await refreshTagUsage(sql, [input.targetTagId]);

    await recordAudit(sql, ctx, {
      action: 'tag.merged',
      resourceType: 'tag',
      resourceId: input.targetTagId,
      newState: { source_tag_ids: input.sourceTagIds, assignments_moved: moved.length },
      confirmationId,
    });

    return { merged: sources.length, assignments_moved: moved.length };
  });
}

export async function refreshTagUsage(sql: Sql, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  await sql.query(
    `UPDATE tags t
     SET usage_count = (SELECT count(*) FROM source_tags st WHERE st.tag_id = t.id)
     WHERE t.id = ANY($1::uuid[])`,
    [tagIds],
  );
}

// ---------------------------------------------------------------------

export async function uniqueSlug(sql: Sql, table: string, base: string): Promise<string> {
  // Table name comes from a literal at the call site, never from input.
  const allowed = ['categories', 'collections'];
  if (!allowed.includes(table)) throw new Error(`uniqueSlug called with unexpected table: ${table}`);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await sql.one(`SELECT 1 FROM ${table} WHERE slug = $1`, [candidate]);
    if (!existing) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
