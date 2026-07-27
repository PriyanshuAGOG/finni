import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { requirePermission } from '../lib/context';
import { conflict, invalidInput, notFound, versionConflict } from '../lib/errors';
import { normalizeTaxonomyName, slugify, truncate } from '../lib/text';
import { recordAudit, decodeCursor, encodeCursor } from './audit';
import { guardConfirmation } from './confirmation';
import { uniqueSlug } from './taxonomy';

export interface Collection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  purpose: string | null;
  research_question: string | null;
  collection_type: string;
  visibility: string;
  owner_id: string | null;
  status: string;
  summary: string | null;
  key_findings: string[];
  contradictions: string[];
  knowledge_gaps: string[];
  evidence_status: string | null;
  pinned: boolean;
  version: number;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  source_count?: number;
  dashboard_url?: string;
}

const COLLECTION_FIELDS = [
  'id', 'name', 'slug', 'description', 'purpose', 'research_question',
  'collection_type', 'visibility', 'owner_id', 'status', 'summary',
  'key_findings', 'contradictions', 'knowledge_gaps', 'evidence_status',
  'pinned', 'version', 'last_reviewed_at', 'created_at', 'updated_at',
];

/** Qualified for SELECTs that join; bare for RETURNING clauses. */
const COLLECTION_COLUMNS = COLLECTION_FIELDS.map((f) => `c.${f}`).join(', ');
const COLLECTION_COLUMNS_BARE = COLLECTION_FIELDS.join(', ');

function withUrl(row: Collection): Collection {
  return { ...row, dashboard_url: `/collections/${row.id}` };
}

export async function listCollections(
  ctx: ActorContext,
  query: {
    query?: string;
    collectionType?: string;
    ownerId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ items: Collection[]; nextCursor: string | null }> {
  requirePermission(ctx, 'collection.read');

  const limit = Math.min(query.limit ?? 25, 100);

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [`c.status = ${add(query.status ?? 'active')}::lifecycle_status`];

    if (query.query) {
      where.push(
        `(c.normalized_name % ${add(normalizeTaxonomyName(query.query))}
          OR lower(c.name) LIKE ${add(`%${query.query.toLowerCase()}%`)}
          OR lower(coalesce(c.description,'')) LIKE ${add(`%${query.query.toLowerCase()}%`)})`,
      );
    }
    if (query.collectionType) {
      where.push(`c.collection_type = ${add(query.collectionType)}::collection_type`);
    }
    if (query.ownerId) where.push(`c.owner_id = ${add(query.ownerId)}`);

    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      where.push(`(c.created_at, c.id) < (${add(decoded.createdAt)}, ${add(decoded.id)})`);
    }

    const rows = await sql.query<Collection>(
      `SELECT ${COLLECTION_COLUMNS},
              (SELECT count(*) FROM collection_sources cs
               JOIN sources s ON s.id = cs.source_id
               WHERE cs.collection_id = c.id AND s.status = 'active')::int AS source_count
       FROM collections c
       WHERE ${where.join(' AND ')}
       ORDER BY c.pinned DESC, c.created_at DESC, c.id DESC
       LIMIT ${add(limit + 1)}`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(withUrl);
    return {
      items: page,
      nextCursor: hasMore
        ? encodeCursor({
            createdAt: page[page.length - 1].created_at,
            id: page[page.length - 1].id,
          })
        : null,
    };
  });
}

export async function getCollection(
  ctx: ActorContext,
  collectionId: string,
  options: {
    includeSources?: boolean;
    includeClaims?: boolean;
    includeBriefs?: boolean;
    includeActivity?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'collection.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const collection = await sql.one<Collection>(
      `SELECT ${COLLECTION_COLUMNS},
              (SELECT count(*) FROM collection_sources cs
               JOIN sources s ON s.id = cs.source_id
               WHERE cs.collection_id = c.id AND s.status = 'active')::int AS source_count
       FROM collections c WHERE c.id = $1`,
      [collectionId],
    );
    if (!collection) throw notFound('collection', collectionId);

    const result: Record<string, unknown> = { ...withUrl(collection) };

    // A breakdown by review status, because "12 sources" means something
    // very different when 2 are approved than when 12 are.
    const breakdown = await sql.query<{ review_status: string; count: number }>(
      `SELECT s.review_status::text, count(*)::int
       FROM collection_sources cs JOIN sources s ON s.id = cs.source_id
       WHERE cs.collection_id = $1 AND s.status = 'active'
       GROUP BY s.review_status`,
      [collectionId],
    );
    result.review_status_breakdown = Object.fromEntries(
      breakdown.map((b) => [b.review_status, b.count]),
    );

    if (options.includeSources) {
      result.sources = await sql.query(
        `SELECT s.id, s.title, s.source_type, s.publisher, s.publication_date,
                s.review_status, s.processing_status, s.ai_summary_short,
                cs.position, cs.section, cs.reason_added, cs.created_at AS added_at
         FROM collection_sources cs JOIN sources s ON s.id = cs.source_id
         WHERE cs.collection_id = $1 AND s.status = 'active'
         ORDER BY cs.position, s.publication_date DESC NULLS LAST`,
        [collectionId],
      );
    }

    if (options.includeClaims) {
      result.claims = await sql.query(
        `SELECT DISTINCT cl.id, cl.canonical_text, cl.evidence_status,
                cl.clinical_review_status, cl.safety_relevance
         FROM collection_sources cs
         JOIN claim_evidence ce ON ce.source_id = cs.source_id
         JOIN claims cl ON cl.id = ce.claim_id
         WHERE cs.collection_id = $1 AND cl.status = 'active'
         ORDER BY cl.canonical_text`,
        [collectionId],
      );
    }

    if (options.includeBriefs) {
      result.briefs = await sql.query(
        `SELECT DISTINCT b.id, b.title, b.brief_type, b.status, b.created_at
         FROM research_briefs b
         JOIN brief_sources bs ON bs.brief_id = b.id
         JOIN collection_sources cs ON cs.source_id = bs.source_id
         WHERE cs.collection_id = $1 AND b.archived_at IS NULL
         ORDER BY b.created_at DESC`,
        [collectionId],
      );
    }

    if (options.includeActivity) {
      result.activity = await sql.query(
        `SELECT a.id, a.action, a.changed_fields, a.source_interface, a.created_at,
                u.full_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.resource_type = 'collection' AND a.resource_id = $1
         ORDER BY a.created_at DESC LIMIT 50`,
        [collectionId],
      );
    }

    const rules = await sql.one(
      `SELECT rules, refresh_mode, last_refreshed_at FROM smart_collection_rules WHERE collection_id = $1`,
      [collectionId],
    );
    if (rules) result.smart_rules = rules;

    return result;
  });
}

export interface SimilarCollection {
  id: string;
  name: string;
  research_question: string | null;
  source_count: number;
  similarity: number;
  dashboard_url: string;
}

export async function findSimilarCollections(
  ctx: ActorContext,
  name: string,
): Promise<SimilarCollection[]> {
  requirePermission(ctx, 'collection.read');
  const normalized = normalizeTaxonomyName(name);
  if (!normalized) return [];

  return withOrg(ctx.organizationId, async (sql) => {
    const rows = await sql.query<SimilarCollection & { raw_similarity: number }>(
      `SELECT c.id, c.name, c.research_question,
              (SELECT count(*) FROM collection_sources cs WHERE cs.collection_id = c.id)::int AS source_count,
              similarity(c.normalized_name, $1) AS raw_similarity
       FROM collections c
       WHERE c.status = 'active' AND (c.normalized_name % $1 OR c.normalized_name = $1)
       ORDER BY raw_similarity DESC LIMIT 5`,
      [normalized],
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      research_question: r.research_question,
      source_count: r.source_count,
      similarity: Number(r.raw_similarity),
      dashboard_url: `/collections/${r.id}`,
    }));
  });
}

export async function createCollection(
  ctx: ActorContext,
  input: {
    name: string;
    description?: string | null;
    purpose?: string | null;
    researchQuestion?: string | null;
    collectionType?: string;
    visibility?: string;
    sourceIds?: string[];
    smartRules?: Record<string, unknown> | null;
  },
): Promise<Collection & { similar_collections?: SimilarCollection[] }> {
  requirePermission(ctx, 'collection.create');

  const name = input.name?.trim();
  if (!name) throw invalidInput('A collection name is required.');

  // Reported rather than blocked: unlike taxonomy, several collections on
  // one topic are often legitimate (a content project and a clinical
  // review can share a subject). The caller is told so it can ask.
  const similar = await findSimilarCollections(ctx, name);

  return withOrg(ctx.organizationId, async (sql) => {
    const slug = await uniqueSlug(sql, 'collections', slugify(name));

    const row = await sql.one<Collection>(
      `INSERT INTO collections (
         organization_id, name, normalized_name, slug, description, purpose,
         research_question, collection_type, visibility, owner_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::collection_type,$9::visibility_level,$10,$10,$10)
       RETURNING ${COLLECTION_COLUMNS_BARE}`,
      [
        ctx.organizationId,
        name,
        normalizeTaxonomyName(name),
        slug,
        input.description ?? null,
        input.purpose ?? null,
        input.researchQuestion ?? null,
        input.collectionType ?? 'manual',
        input.visibility ?? 'organization',
        ctx.userId,
      ],
    );

    if (input.smartRules) {
      await sql.query(
        `INSERT INTO smart_collection_rules (collection_id, rules, refresh_mode)
         VALUES ($1,$2,'manual')`,
        [row!.id, JSON.stringify(input.smartRules)],
      );
    }

    let added = 0;
    if (input.sourceIds?.length) {
      const valid = await sql.query<{ id: string }>(
        `SELECT id FROM sources WHERE id = ANY($1::uuid[]) AND status = 'active'`,
        [input.sourceIds],
      );
      for (const [index, source] of valid.entries()) {
        await sql.query(
          `INSERT INTO collection_sources (collection_id, source_id, position, added_by, added_via)
           VALUES ($1,$2,$3,$4,$5::source_interface) ON CONFLICT DO NOTHING`,
          [row!.id, source.id, index, ctx.userId, ctx.sourceInterface],
        );
        added += 1;
      }
    }

    await recordAudit(sql, ctx, {
      action: 'collection.created',
      resourceType: 'collection',
      resourceId: row!.id,
      newState: {
        name,
        collection_type: input.collectionType ?? 'manual',
        research_question: input.researchQuestion ?? null,
        initial_source_count: added,
      },
    });

    return {
      ...withUrl({ ...row!, source_count: added }),
      ...(similar.length > 0 ? { similar_collections: similar } : {}),
    };
  });
}

export async function updateCollection(
  ctx: ActorContext,
  collectionId: string,
  updates: {
    name?: string;
    description?: string | null;
    purpose?: string | null;
    researchQuestion?: string | null;
    collectionType?: string;
    visibility?: string;
    summary?: string | null;
    pinned?: boolean;
    expectedVersion?: number;
  },
): Promise<Collection> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Collection>(
      `SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.id = $1 FOR UPDATE`,
      [collectionId],
    );
    if (!existing) throw notFound('collection', collectionId);
    if (updates.expectedVersion !== undefined && updates.expectedVersion !== existing.version) {
      throw versionConflict('collection', existing.version);
    }

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];
    const previous: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};

    const set = (column: string, value: unknown, cast = '') => {
      if (value === undefined) return;
      previous[column] = (existing as unknown as Record<string, unknown>)[column];
      next[column] = value;
      sets.push(`${column} = ${add(value)}${cast}`);
    };

    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) throw invalidInput('A collection name cannot be empty.');
      set('name', name);
      sets.push(`normalized_name = ${add(normalizeTaxonomyName(name))}`);
    }
    set('description', updates.description);
    set('purpose', updates.purpose);
    set('research_question', updates.researchQuestion);
    set('collection_type', updates.collectionType, '::collection_type');
    set('visibility', updates.visibility, '::visibility_level');
    set('summary', updates.summary);
    set('pinned', updates.pinned);

    if (sets.length === 0) return withUrl(existing);
    sets.push(`updated_by = ${add(ctx.userId)}`, 'updated_at = now()', 'version = version + 1');

    const row = await sql.one<Collection>(
      `UPDATE collections c SET ${sets.join(', ')} WHERE c.id = ${add(collectionId)}
       RETURNING ${COLLECTION_COLUMNS}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'collection.updated',
      resourceType: 'collection',
      resourceId: collectionId,
      previousState: previous,
      newState: next,
    });

    return withUrl(row!);
  });
}

export async function addSourcesToCollection(
  ctx: ActorContext,
  collectionId: string,
  input: { sourceIds: string[]; section?: string | null; reasonAdded?: string | null },
): Promise<{ added: string[]; already_present: string[]; not_found: string[]; source_count: number }> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const collection = await sql.one<{ id: string; name: string }>(
      `SELECT id, name FROM collections WHERE id = $1 AND status = 'active'`,
      [collectionId],
    );
    if (!collection) throw notFound('collection', collectionId);

    const valid = await sql.query<{ id: string }>(
      `SELECT id FROM sources WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [input.sourceIds],
    );
    const validIds = new Set(valid.map((v) => v.id));
    const notFoundIds = input.sourceIds.filter((id) => !validIds.has(id));

    const existing = await sql.query<{ source_id: string }>(
      `SELECT source_id FROM collection_sources WHERE collection_id = $1 AND source_id = ANY($2::uuid[])`,
      [collectionId, [...validIds]],
    );
    const alreadyPresent = new Set(existing.map((e) => e.source_id));

    const positionRow = await sql.one<{ max: number | null }>(
      `SELECT max(position) AS max FROM collection_sources WHERE collection_id = $1`,
      [collectionId],
    );
    let position = (positionRow?.max ?? -1) + 1;

    const added: string[] = [];
    for (const id of validIds) {
      if (alreadyPresent.has(id)) continue;
      await sql.query(
        `INSERT INTO collection_sources (collection_id, source_id, position, section, reason_added, added_by, added_via)
         VALUES ($1,$2,$3,$4,$5,$6,$7::source_interface)`,
        [
          collectionId,
          id,
          position++,
          input.section ?? null,
          input.reasonAdded ?? null,
          ctx.userId,
          ctx.sourceInterface,
        ],
      );
      added.push(id);
    }

    const count = await sql.one<{ count: number }>(
      `SELECT count(*)::int FROM collection_sources cs
       JOIN sources s ON s.id = cs.source_id
       WHERE cs.collection_id = $1 AND s.status = 'active'`,
      [collectionId],
    );

    if (added.length > 0) {
      await recordAudit(sql, ctx, {
        action: 'collection.sources_added',
        resourceType: 'collection',
        resourceId: collectionId,
        newState: { added_source_ids: added, reason_added: input.reasonAdded ?? null },
      });
    }

    return {
      added,
      already_present: [...alreadyPresent],
      not_found: notFoundIds,
      source_count: count?.count ?? 0,
    };
  });
}

export async function removeSourcesFromCollection(
  ctx: ActorContext,
  collectionId: string,
  sourceIds: string[],
): Promise<{ removed: string[]; source_count: number }> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const collection = await sql.one<{ id: string }>(
      `SELECT id FROM collections WHERE id = $1 AND status = 'active'`,
      [collectionId],
    );
    if (!collection) throw notFound('collection', collectionId);

    const removed = await sql.query<{ source_id: string }>(
      `DELETE FROM collection_sources
       WHERE collection_id = $1 AND source_id = ANY($2::uuid[])
       RETURNING source_id`,
      [collectionId, sourceIds],
    );

    const count = await sql.one<{ count: number }>(
      `SELECT count(*)::int FROM collection_sources WHERE collection_id = $1`,
      [collectionId],
    );

    if (removed.length > 0) {
      await recordAudit(sql, ctx, {
        action: 'collection.sources_removed',
        resourceType: 'collection',
        resourceId: collectionId,
        previousState: { source_ids: removed.map((r) => r.source_id) },
        newState: { removed: removed.length },
      });
    }

    return { removed: removed.map((r) => r.source_id), source_count: count?.count ?? 0 };
  });
}

export async function reorderCollectionSources(
  ctx: ActorContext,
  collectionId: string,
  orderedSourceIds: string[],
): Promise<{ reordered: number }> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const collection = await sql.one(`SELECT id FROM collections WHERE id = $1 AND status = 'active'`, [
      collectionId,
    ]);
    if (!collection) throw notFound('collection', collectionId);

    let reordered = 0;
    for (const [index, sourceId] of orderedSourceIds.entries()) {
      const result = await sql.query(
        `UPDATE collection_sources SET position = $1
         WHERE collection_id = $2 AND source_id = $3 RETURNING source_id`,
        [index, collectionId, sourceId],
      );
      reordered += result.length;
    }

    await recordAudit(sql, ctx, {
      action: 'collection.sources_reordered',
      resourceType: 'collection',
      resourceId: collectionId,
      newState: { ordered_source_ids: orderedSourceIds },
    });

    return { reordered };
  });
}

export async function archiveCollection(
  ctx: ActorContext,
  collectionId: string,
  confirmationId?: string | null,
): Promise<Collection> {
  requirePermission(ctx, 'collection.archive');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Collection & { source_count: number }>(
      `SELECT ${COLLECTION_COLUMNS},
              (SELECT count(*) FROM collection_sources cs WHERE cs.collection_id = c.id)::int AS source_count
       FROM collections c WHERE c.id = $1 FOR UPDATE`,
      [collectionId],
    );
    if (!existing) throw notFound('collection', collectionId);
    if (existing.status !== 'active') throw conflict(`This collection is already ${existing.status}.`);

    const usedConfirmation = await guardConfirmation(sql, ctx, {
      actionType: 'archiveCollection',
      resourceType: 'collection',
      resourceIds: [collectionId],
      actionPayload: {},
      humanSummary: `Archive the collection "${truncate(existing.name, 80)}" containing ${existing.source_count} source(s). The sources themselves are not affected, and the collection can be restored.`,
      confirmationId,
    });

    const row = await sql.one<Collection>(
      `UPDATE collections c
       SET status = 'archived', archived_at = now(), archived_by = $1,
           updated_by = $1, updated_at = now(), version = version + 1
       WHERE c.id = $2
       RETURNING ${COLLECTION_COLUMNS}`,
      [ctx.userId, collectionId],
    );

    await recordAudit(sql, ctx, {
      action: 'collection.archived',
      resourceType: 'collection',
      resourceId: collectionId,
      previousState: { status: 'active' },
      newState: { status: 'archived' },
      confirmationId: usedConfirmation,
    });

    return withUrl(row!);
  });
}

export async function restoreCollection(
  ctx: ActorContext,
  collectionId: string,
): Promise<Collection> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Collection>(
      `SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.id = $1`,
      [collectionId],
    );
    if (!existing) throw notFound('collection', collectionId);
    if (existing.status === 'active') throw conflict('This collection is already active.');

    const row = await sql.one<Collection>(
      `UPDATE collections c
       SET status = 'active', archived_at = NULL, archived_by = NULL,
           updated_by = $1, updated_at = now(), version = version + 1
       WHERE c.id = $2
       RETURNING ${COLLECTION_COLUMNS}`,
      [ctx.userId, collectionId],
    );

    await recordAudit(sql, ctx, {
      action: 'collection.restored',
      resourceType: 'collection',
      resourceId: collectionId,
      previousState: { status: existing.status },
      newState: { status: 'active' },
    });

    return withUrl(row!);
  });
}

/**
 * Refreshes a smart collection from its stored rules. Membership is
 * recomputed rather than appended so a source that no longer matches
 * leaves the collection.
 */
export async function refreshSmartCollection(
  ctx: ActorContext,
  collectionId: string,
): Promise<{ added: number; removed: number; total: number }> {
  requirePermission(ctx, 'collection.update');

  return withOrg(ctx.organizationId, async (sql) => {
    const rules = await sql.one<{ rules: Record<string, unknown> }>(
      `SELECT rules FROM smart_collection_rules WHERE collection_id = $1`,
      [collectionId],
    );
    if (!rules) {
      throw conflict('This collection has no smart rules configured.', { collection_id: collectionId });
    }

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [`s.status = 'active'`];
    const r = rules.rules as Record<string, unknown>;

    if (Array.isArray(r.category_ids) && r.category_ids.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM source_categories sc WHERE sc.source_id = s.id AND sc.category_id = ANY(${add(r.category_ids)}::uuid[]))`,
      );
    }
    if (Array.isArray(r.tag_ids) && r.tag_ids.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id AND st.tag_id = ANY(${add(r.tag_ids)}::uuid[]))`,
      );
    }
    if (Array.isArray(r.review_status) && r.review_status.length > 0) {
      where.push(`s.review_status = ANY(${add(r.review_status)}::review_status[])`);
    }
    if (Array.isArray(r.source_types) && r.source_types.length > 0) {
      where.push(`s.source_type = ANY(${add(r.source_types)}::source_type[])`);
    }
    if (typeof r.published_after === 'string') {
      where.push(`s.publication_date >= ${add(r.published_after)}`);
    }
    if (typeof r.query === 'string' && r.query.trim()) {
      where.push(`s.search_vector @@ plainto_tsquery('english', ${add(r.query)})`);
    }

    const matches = await sql.query<{ id: string }>(
      `SELECT s.id FROM sources s WHERE ${where.join(' AND ')} LIMIT 1000`,
      params,
    );
    const matchIds = matches.map((m) => m.id);

    const removed = await sql.query<{ source_id: string }>(
      `DELETE FROM collection_sources
       WHERE collection_id = $1 AND source_id != ALL($2::uuid[])
       RETURNING source_id`,
      [collectionId, matchIds],
    );

    let added = 0;
    for (const [index, id] of matchIds.entries()) {
      const result = await sql.query(
        `INSERT INTO collection_sources (collection_id, source_id, position, reason_added, added_by, added_via)
         VALUES ($1,$2,$3,'Matched the smart collection rules',$4,'automation')
         ON CONFLICT DO NOTHING RETURNING source_id`,
        [collectionId, id, index, ctx.userId],
      );
      added += result.length;
    }

    await sql.query(
      `UPDATE smart_collection_rules SET last_refreshed_at = now() WHERE collection_id = $1`,
      [collectionId],
    );

    await recordAudit(sql, ctx, {
      action: 'collection.smart_refreshed',
      resourceType: 'collection',
      resourceId: collectionId,
      newState: { added, removed: removed.length, total: matchIds.length },
    });

    return { added, removed: removed.length, total: matchIds.length };
  });
}
