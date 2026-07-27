import { z } from 'zod';
import { defineOperation } from '../registry';
import {
  archiveAnnotation,
  createAnnotation,
  listAnnotations,
  resolveAnnotation,
  updateAnnotation,
} from '../../services/annotation';

const annotationType = z.enum([
  'note', 'highlight', 'important_statistic', 'question', 'correction',
  'safety_warning', 'contradiction', 'content_idea', 'review_request',
  'limitation', 'interpretation',
]);

export const listAnnotationsOperation = defineOperation({
  operationId: 'listAnnotations',
  method: 'GET',
  path: '/annotations',
  summary: 'List annotations on sources or claims',
  description:
    'Returns annotations filtered by source, claim, author, type, status or assignee. Private annotations are only visible to their author. This operation does not modify anything.',
  tags: ['annotations'],
  permission: 'annotation.read',
  scopes: ['annotation.read'],
  riskLevel: 'low',
  input: z.object({
    source_id: z.string().uuid().optional(),
    claim_id: z.string().uuid().optional(),
    user_id: z.string().uuid().optional(),
    annotation_type: z.array(annotationType).optional(),
    status: z.string().optional(),
    assigned_to: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  handler: (input, { ctx }) =>
    listAnnotations(ctx, {
      sourceId: input.source_id,
      claimId: input.claim_id,
      userId: input.user_id,
      annotationType: input.annotation_type,
      status: input.status,
      assignedTo: input.assigned_to,
      limit: input.limit,
    }),
});

export const createAnnotationOperation = defineOperation({
  operationId: 'createAnnotation',
  method: 'POST',
  path: '/annotations',
  summary: 'Add a note, highlight, question or safety warning',
  description: `Creates an annotation on a source or a claim: a note, highlight, important statistic, question, correction, safety warning, contradiction flag, content idea, review request, limitation or interpretation.

When passage_id is supplied, the annotation is anchored to that stored passage so it stays attached to real text even after re-extraction. Use safety_warning for anything a clinical reviewer needs to see before content ships.

This operation writes.`,
  tags: ['annotations'],
  permission: 'annotation.create',
  scopes: ['annotation.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    source_id: z.string().uuid().nullish(),
    claim_id: z.string().uuid().nullish(),
    annotation_type: annotationType.optional(),
    body: z.string().nullish(),
    selected_text: z.string().nullish(),
    passage_id: z.string().uuid().nullish(),
    page_number: z.coerce.number().int().nullish(),
    locator: z.string().nullish(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
    assigned_to: z.string().uuid().nullish(),
  }),
  handler: (input, { ctx }) =>
    createAnnotation(ctx, {
      sourceId: input.source_id,
      claimId: input.claim_id,
      annotationType: input.annotation_type,
      body: input.body,
      selectedText: input.selected_text,
      passageId: input.passage_id,
      pageNumber: input.page_number,
      locator: input.locator,
      visibility: input.visibility,
      assignedTo: input.assigned_to,
    }),
});

export const updateAnnotationOperation = defineOperation({
  operationId: 'updateAnnotation',
  method: 'PATCH',
  path: '/annotations/{annotationId}',
  summary: 'Edit an annotation',
  description: `Updates an annotation's body, type, visibility or assignment.

Editing your own annotation needs annotation.update_own; editing someone else's needs annotation.update_any. This operation writes.`,
  tags: ['annotations'],
  scopes: ['annotation.write'],
  riskLevel: 'medium',
  input: z.object({
    annotationId: z.string().uuid(),
    body: z.string().nullish(),
    annotation_type: annotationType.optional(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
    assigned_to: z.string().uuid().nullish(),
    status: z.string().optional(),
  }),
  handler: (input, { ctx }) =>
    updateAnnotation(ctx, input.annotationId, {
      body: input.body,
      annotationType: input.annotation_type,
      visibility: input.visibility,
      assignedTo: input.assigned_to,
      status: input.status,
    }),
});

export const resolveAnnotationOperation = defineOperation({
  operationId: 'resolveAnnotation',
  method: 'POST',
  path: '/annotations/{annotationId}/resolve',
  summary: 'Mark an annotation resolved',
  description:
    'Marks an annotation resolved, with an optional closing note. The author, the assignee, or anyone with annotation.update_any may resolve it. This operation writes.',
  tags: ['annotations'],
  scopes: ['annotation.write'],
  riskLevel: 'medium',
  input: z.object({
    annotationId: z.string().uuid(),
    note: z.string().optional(),
  }),
  handler: (input, { ctx }) => resolveAnnotation(ctx, input.annotationId, input.note),
});

export const archiveAnnotationOperation = defineOperation({
  operationId: 'archiveAnnotation',
  method: 'POST',
  path: '/annotations/{annotationId}/archive',
  summary: 'Archive (soft-delete) an annotation',
  description: `Archives an annotation so it no longer appears in listings.

Archiving your own annotation needs annotation.delete_own; archiving someone else's needs annotation.delete_any. This operation writes.`,
  tags: ['annotations'],
  scopes: ['annotation.write'],
  riskLevel: 'medium',
  input: z.object({ annotationId: z.string().uuid() }),
  handler: (input, { ctx }) => archiveAnnotation(ctx, input.annotationId),
});
