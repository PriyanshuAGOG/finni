import { withOrg } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { hasPermission, requirePermission } from '../lib/context';
import { conflict, forbidden, invalidInput, notFound } from '../lib/errors';
import { chunkLocator } from '../extraction/chunk';
import { truncate } from '../lib/text';
import { recordAudit } from './audit';

export interface Annotation {
  id: string;
  source_id: string | null;
  claim_id: string | null;
  user_id: string;
  annotation_type: string;
  body: string | null;
  selected_text: string | null;
  page_number: number | null;
  locator: string | null;
  visibility: string;
  status: string;
  assigned_to: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  author_name?: string;
  dashboard_url?: string;
}

const ANNOTATION_FIELDS = [
  'id', 'source_id', 'claim_id', 'user_id', 'annotation_type::text', 'body',
  'selected_text', 'page_number', 'locator', 'visibility::text', 'status',
  'assigned_to', 'resolved_at', 'created_at', 'updated_at',
];

/** Qualified for SELECTs that join; bare for RETURNING clauses. */
const ANNOTATION_COLUMNS = ANNOTATION_FIELDS.map((f) => `a.${f}`).join(', ');
const ANNOTATION_COLUMNS_BARE = ANNOTATION_FIELDS.join(', ');

function withUrl(row: Annotation): Annotation {
  return {
    ...row,
    dashboard_url: row.source_id
      ? `/library/${row.source_id}?tab=annotations#annotation-${row.id}`
      : row.claim_id
        ? `/claims/${row.claim_id}#annotation-${row.id}`
        : '/activity',
  };
}

export async function listAnnotations(
  ctx: ActorContext,
  query: {
    sourceId?: string;
    claimId?: string;
    userId?: string;
    annotationType?: string[];
    status?: string;
    assignedTo?: string;
    limit?: number;
  } = {},
): Promise<Annotation[]> {
  requirePermission(ctx, 'annotation.read');

  return withOrg(ctx.organizationId, async (sql) => {
    const params: unknown[] = [ctx.userId];
    const add = (v: unknown) => `$${params.push(v)}`;

    // A private annotation is visible only to its author. Everything else
    // is organization-visible.
    const where = [`a.archived_at IS NULL`, `(a.visibility != 'private' OR a.user_id = $1)`];

    if (query.sourceId) where.push(`a.source_id = ${add(query.sourceId)}`);
    if (query.claimId) where.push(`a.claim_id = ${add(query.claimId)}`);
    if (query.userId) where.push(`a.user_id = ${add(query.userId)}`);
    if (query.annotationType?.length) {
      where.push(`a.annotation_type = ANY(${add(query.annotationType)}::annotation_type[])`);
    }
    if (query.status) where.push(`a.status = ${add(query.status)}`);
    if (query.assignedTo) where.push(`a.assigned_to = ${add(query.assignedTo)}`);

    const rows = await sql.query<Annotation>(
      `SELECT ${ANNOTATION_COLUMNS}, u.full_name AS author_name
       FROM annotations a JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT ${add(Math.min(query.limit ?? 50, 200))}`,
      params,
    );

    return rows.map(withUrl);
  });
}

export async function createAnnotation(
  ctx: ActorContext,
  input: {
    sourceId?: string | null;
    claimId?: string | null;
    annotationType?: string;
    body?: string | null;
    selectedText?: string | null;
    passageId?: string | null;
    pageNumber?: number | null;
    locator?: string | null;
    visibility?: string;
    assignedTo?: string | null;
  },
): Promise<Annotation> {
  requirePermission(ctx, 'annotation.create');

  if (!input.sourceId && !input.claimId) {
    throw invalidInput('An annotation must reference either a source or a claim.');
  }
  if (!input.body?.trim() && !input.selectedText?.trim()) {
    throw invalidInput('An annotation needs either a body or selected text.');
  }

  return withOrg(ctx.organizationId, async (sql) => {
    if (input.sourceId) {
      const source = await sql.one(`SELECT id FROM sources WHERE id = $1 AND status != 'deleted'`, [
        input.sourceId,
      ]);
      if (!source) throw notFound('source', input.sourceId);
    }
    if (input.claimId) {
      const claim = await sql.one(`SELECT id FROM claims WHERE id = $1`, [input.claimId]);
      if (!claim) throw notFound('claim', input.claimId);
    }
    if (input.assignedTo) {
      const user = await sql.one(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [
        input.assignedTo,
      ]);
      if (!user) throw notFound('user', input.assignedTo);
    }

    let locator = input.locator ?? null;
    let pageNumber = input.pageNumber ?? null;
    let selectedText = input.selectedText ?? null;

    // Anchoring to a stored passage means the annotation still points at
    // real text if the source is later re-extracted.
    if (input.passageId) {
      const chunk = await sql.one<{
        chunk_text: string;
        page_number: number | null;
        heading_path: string | null;
        chunk_index: number;
        start_offset: number | null;
        source_id: string;
      }>(`SELECT * FROM embedding_chunks WHERE id = $1`, [input.passageId]);
      if (!chunk) throw notFound('passage', input.passageId);
      if (input.sourceId && chunk.source_id !== input.sourceId) {
        throw invalidInput('The supplied passage belongs to a different source.');
      }
      pageNumber = chunk.page_number;
      locator = chunkLocator({
        pageNumber: chunk.page_number,
        headingPath: chunk.heading_path,
        chunkIndex: chunk.chunk_index,
        startOffset: chunk.start_offset,
      });
      if (!selectedText) selectedText = truncate(chunk.chunk_text, 1000);
    }

    const row = await sql.one<Annotation>(
      `INSERT INTO annotations (
         organization_id, source_id, claim_id, user_id, annotation_type, body,
         selected_text, page_number, locator, chunk_id, visibility, assigned_to, created_via
       ) VALUES ($1,$2,$3,$4,$5::annotation_type,$6,$7,$8,$9,$10,$11::visibility_level,$12,$13::source_interface)
       RETURNING ${ANNOTATION_COLUMNS_BARE}`,
      [
        ctx.organizationId,
        input.sourceId ?? null,
        input.claimId ?? null,
        ctx.userId,
        input.annotationType ?? 'note',
        input.body ?? null,
        selectedText,
        pageNumber,
        locator,
        input.passageId ?? null,
        input.visibility ?? 'organization',
        input.assignedTo ?? null,
        ctx.sourceInterface,
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'annotation.created',
      resourceType: 'annotation',
      resourceId: row!.id,
      newState: {
        annotation_type: input.annotationType ?? 'note',
        source_id: input.sourceId ?? null,
        claim_id: input.claimId ?? null,
        assigned_to: input.assignedTo ?? null,
      },
    });

    return withUrl({ ...row!, author_name: ctx.userName });
  });
}

export async function updateAnnotation(
  ctx: ActorContext,
  annotationId: string,
  updates: {
    body?: string | null;
    annotationType?: string;
    visibility?: string;
    assignedTo?: string | null;
    status?: string;
  },
): Promise<Annotation> {
  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Annotation>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations a WHERE a.id = $1`,
      [annotationId],
    );
    if (!existing) throw notFound('annotation', annotationId);

    requireAnnotationWrite(ctx, existing, 'update');

    const params: unknown[] = [];
    const add = (v: unknown) => `$${params.push(v)}`;
    const sets: string[] = [];
    const previous: Record<string, unknown> = {};

    if (updates.body !== undefined) {
      previous.body = existing.body;
      sets.push(`body = ${add(updates.body)}`);
    }
    if (updates.annotationType !== undefined) {
      previous.annotation_type = existing.annotation_type;
      sets.push(`annotation_type = ${add(updates.annotationType)}::annotation_type`);
    }
    if (updates.visibility !== undefined) {
      previous.visibility = existing.visibility;
      sets.push(`visibility = ${add(updates.visibility)}::visibility_level`);
    }
    if (updates.assignedTo !== undefined) {
      previous.assigned_to = existing.assigned_to;
      sets.push(`assigned_to = ${add(updates.assignedTo)}`);
    }
    if (updates.status !== undefined) {
      previous.status = existing.status;
      sets.push(`status = ${add(updates.status)}`);
    }

    if (sets.length === 0) return withUrl(existing);
    sets.push('updated_at = now()');

    const row = await sql.one<Annotation>(
      `UPDATE annotations a SET ${sets.join(', ')} WHERE a.id = ${add(annotationId)}
       RETURNING ${ANNOTATION_COLUMNS}`,
      params,
    );

    await recordAudit(sql, ctx, {
      action: 'annotation.updated',
      resourceType: 'annotation',
      resourceId: annotationId,
      previousState: previous,
      newState: updates as Record<string, unknown>,
    });

    return withUrl(row!);
  });
}

export async function resolveAnnotation(
  ctx: ActorContext,
  annotationId: string,
  note?: string,
): Promise<Annotation> {
  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Annotation>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations a WHERE a.id = $1`,
      [annotationId],
    );
    if (!existing) throw notFound('annotation', annotationId);
    if (existing.status === 'resolved') throw conflict('This annotation is already resolved.');

    // Resolving is not editing: the author, the assignee, or anyone who
    // can update any annotation may close it out.
    const canResolve =
      existing.user_id === ctx.userId ||
      existing.assigned_to === ctx.userId ||
      hasPermission(ctx, 'annotation.update_any');
    if (!canResolve) throw forbidden('annotation.update_any');

    const row = await sql.one<Annotation>(
      `UPDATE annotations a
       SET status = 'resolved', resolved_at = now(), resolved_by = $1,
           body = CASE WHEN $2::text IS NULL THEN body
                       ELSE coalesce(body,'') || E'\n\n[resolved] ' || $2 END,
           updated_at = now()
       WHERE a.id = $3
       RETURNING ${ANNOTATION_COLUMNS}`,
      [ctx.userId, note ?? null, annotationId],
    );

    await recordAudit(sql, ctx, {
      action: 'annotation.resolved',
      resourceType: 'annotation',
      resourceId: annotationId,
      previousState: { status: existing.status },
      newState: { status: 'resolved', note: note ?? null },
    });

    return withUrl(row!);
  });
}

export async function archiveAnnotation(
  ctx: ActorContext,
  annotationId: string,
): Promise<{ id: string; archived: true }> {
  return withOrg(ctx.organizationId, async (sql) => {
    const existing = await sql.one<Annotation>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations a WHERE a.id = $1`,
      [annotationId],
    );
    if (!existing) throw notFound('annotation', annotationId);

    requireAnnotationWrite(ctx, existing, 'delete');

    await sql.query(
      `UPDATE annotations SET archived_at = now(), archived_by = $1, updated_at = now() WHERE id = $2`,
      [ctx.userId, annotationId],
    );

    await recordAudit(sql, ctx, {
      action: 'annotation.archived',
      resourceType: 'annotation',
      resourceId: annotationId,
      previousState: { body: truncate(existing.body ?? '', 500), archived_at: null },
      newState: { archived_at: new Date().toISOString() },
    });

    return { id: annotationId, archived: true };
  });
}

/**
 * Own-versus-any permission check. Editing your own note needs only
 * `*_own`; editing someone else's needs `*_any`.
 */
function requireAnnotationWrite(
  ctx: ActorContext,
  annotation: Annotation,
  operation: 'update' | 'delete',
): void {
  const isOwn = annotation.user_id === ctx.userId;
  const ownPermission = operation === 'update' ? 'annotation.update_own' : 'annotation.delete_own';
  const anyPermission = operation === 'update' ? 'annotation.update_any' : 'annotation.delete_any';

  if (isOwn && hasPermission(ctx, ownPermission)) return;
  if (hasPermission(ctx, anyPermission)) return;
  throw forbidden(isOwn ? ownPermission : anyPermission);
}
