import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput } from '../handler';
import {
  addSourcesToCollection,
  archiveCollection,
  createCollection,
  findSimilarCollections,
  getCollection,
  listCollections,
  refreshSmartCollection,
  removeSourcesFromCollection,
  reorderCollectionSources,
  restoreCollection,
  updateCollection,
} from '../../services/collection';
import { synthesizeKnowledge } from '../../services/synthesis';

export const listCollectionsOperation = defineOperation({
  operationId: 'listCollections',
  method: 'GET',
  path: '/collections',
  summary: 'List and search collections',
  description:
    'Returns collections with name, type, owner and source count. Use this to browse existing collections or check for one covering a topic before creating a new one. This operation does not modify anything.',
  tags: ['collections'],
  permission: 'collection.read',
  scopes: ['collection.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().optional(),
    collection_type: z.string().optional(),
    owner_id: z.string().uuid().optional(),
    status: z.enum(['active', 'archived']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, { ctx }) => {
    const result = await listCollections(ctx, {
      query: input.query,
      collectionType: input.collection_type,
      ownerId: input.owner_id,
      status: input.status,
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      items: result.items,
      pagination: { next_cursor: result.nextCursor, has_more: Boolean(result.nextCursor), limit: input.limit ?? 25 },
    };
  },
});

export const getCollectionOperation = defineOperation({
  operationId: 'getCollection',
  method: 'GET',
  path: '/collections/{collectionId}',
  summary: 'Get a collection with optional sources, claims, briefs and activity',
  description:
    'Returns a collection and, optionally, its member sources (with a review-status breakdown), related claims, associated briefs and recent activity. This operation does not modify anything.',
  tags: ['collections'],
  permission: 'collection.read',
  scopes: ['collection.read'],
  riskLevel: 'low',
  input: z.object({
    collectionId: z.string().uuid(),
    include_sources: z.coerce.boolean().optional(),
    include_claims: z.coerce.boolean().optional(),
    include_briefs: z.coerce.boolean().optional(),
    include_activity: z.coerce.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    getCollection(ctx, input.collectionId, {
      includeSources: input.include_sources,
      includeClaims: input.include_claims,
      includeBriefs: input.include_briefs,
      includeActivity: input.include_activity,
    }),
});

export const createCollectionOperation = defineOperation({
  operationId: 'createCollection',
  method: 'POST',
  path: '/collections',
  summary: 'Create a new collection',
  description: `Creates a collection to organize sources around a topic, research question or content project.

Before creating one, check listCollections or the similar_collections field this returns for an existing collection covering the same ground -- several collections on one topic are sometimes legitimate, so this is reported rather than blocked, but check with the user if a close match exists.

This operation writes. It is idempotent when given an Idempotency-Key.`,
  gptDescription:
    'Creates a collection to organize sources around a topic or project. Check listCollections/similar_collections first for an existing match; ask the user if a close one exists. Writes; idempotent with an Idempotency-Key.',
  tags: ['collections'],
  permission: 'collection.create',
  scopes: ['collection.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    name: z.string().min(1),
    description: z.string().nullish(),
    purpose: z.string().nullish(),
    research_question: z.string().nullish(),
    collection_type: z
      .enum([
        'manual', 'smart', 'research_project', 'content_project', 'clinical_topic',
        'programme', 'campaign', 'competitor_research', 'patient_education',
      ])
      .optional(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
    source_ids: z.array(z.string().uuid()).optional(),
  }),
  handler: (input, { ctx }) =>
    createCollection(ctx, {
      name: input.name,
      description: input.description,
      purpose: input.purpose,
      researchQuestion: input.research_question,
      collectionType: input.collection_type,
      visibility: input.visibility,
      sourceIds: input.source_ids,
    }),
});

export const findSimilarCollectionsOperation = defineOperation({
  operationId: 'findSimilarCollections',
  method: 'GET',
  path: '/collections/similar',
  summary: 'Find existing collections similar to a proposed name',
  description:
    'Returns collections whose name resembles the given one, with a similarity score. Call this before createCollection to avoid an accidental duplicate. This operation does not modify anything.',
  tags: ['collections'],
  permission: 'collection.read',
  scopes: ['collection.read'],
  riskLevel: 'low',
  input: z.object({ name: z.string().min(1) }),
  handler: (input, { ctx }) => findSimilarCollections(ctx, input.name),
});

export const updateCollectionOperation = defineOperation({
  operationId: 'updateCollection',
  method: 'PATCH',
  path: '/collections/{collectionId}',
  summary: 'Update collection metadata',
  description:
    'Updates name, description, purpose, research question, type, visibility, summary or pinned state. Pass expected_version to guard against a concurrent edit. This operation writes.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({
    collectionId: z.string().uuid(),
    name: z.string().optional(),
    description: z.string().nullish(),
    purpose: z.string().nullish(),
    research_question: z.string().nullish(),
    collection_type: z.string().optional(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
    summary: z.string().nullish(),
    pinned: z.boolean().optional(),
    expected_version: z.coerce.number().int().optional(),
  }),
  handler: (input, { ctx }) => {
    const { collectionId, expected_version: expectedVersion, ...updates } = input;
    return updateCollection(ctx, collectionId, {
      name: updates.name,
      description: updates.description,
      purpose: updates.purpose,
      researchQuestion: updates.research_question,
      collectionType: updates.collection_type,
      visibility: updates.visibility,
      summary: updates.summary,
      pinned: updates.pinned,
      expectedVersion,
    });
  },
});

export const addSourcesToCollectionOperation = defineOperation({
  operationId: 'addSourcesToCollection',
  method: 'POST',
  path: '/collections/{collectionId}/sources',
  summary: 'Add several sources to a collection',
  description:
    'Adds one or more sources to a collection. Reports which were added, which were already present, and which ids were not found. This operation writes.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'low',
  input: z.object({
    collectionId: z.string().uuid(),
    source_ids: z.array(z.string().uuid()).min(1),
    section: z.string().nullish(),
    reason_added: z.string().nullish(),
  }),
  handler: (input, { ctx }) =>
    addSourcesToCollection(ctx, input.collectionId, {
      sourceIds: input.source_ids,
      section: input.section,
      reasonAdded: input.reason_added,
    }),
});

export const removeSourcesFromCollectionOperation = defineOperation({
  operationId: 'removeSourcesFromCollection',
  method: 'DELETE',
  path: '/collections/{collectionId}/sources',
  summary: 'Remove several sources from a collection',
  description:
    'Removes sources from a collection without affecting the source records themselves. This operation writes.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({
    collectionId: z.string().uuid(),
    source_ids: z.array(z.string().uuid()).min(1),
  }),
  handler: (input, { ctx }) => removeSourcesFromCollection(ctx, input.collectionId, input.source_ids),
});

export const reorderCollectionSourcesOperation = defineOperation({
  operationId: 'reorderCollectionSources',
  method: 'POST',
  path: '/collections/{collectionId}/sources/reorder',
  summary: 'Set the display order of sources within a collection',
  description:
    'Sets the position of the listed sources within the collection, in the order supplied. This operation writes.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({
    collectionId: z.string().uuid(),
    ordered_source_ids: z.array(z.string().uuid()).min(1),
  }),
  handler: (input, { ctx }) =>
    reorderCollectionSources(ctx, input.collectionId, input.ordered_source_ids),
});

export const synthesizeCollectionOperation = defineOperation({
  operationId: 'synthesizeCollection',
  method: 'POST',
  path: '/collections/{collectionId}/synthesize',
  summary: 'Generate a cited synthesis from a collection\'s sources',
  description:
    'Runs synthesizeKnowledge scoped to one collection\'s member sources, using the collection\'s research question if the source did not supply one. This operation does not modify anything.',
  tags: ['collections', 'knowledge'],
  permission: 'knowledge.read',
  scopes: ['knowledge.read', 'collection.read'],
  riskLevel: 'low',
  input: z.object({
    collectionId: z.string().uuid(),
    question: z.string().optional(),
    approved_only: z.boolean().optional(),
    include_contradictions: z.boolean().optional(),
    include_gaps: z.boolean().optional(),
  }),
  handler: async (input, { ctx }) => {
    const { getCollection: getCollectionRaw } = await import('../../services/collection');
    const collection = await getCollectionRaw(ctx, input.collectionId);
    const question =
      input.question ?? (collection.research_question as string) ?? (collection.name as string);

    return synthesizeKnowledge(ctx, {
      question,
      collectionIds: [input.collectionId],
      approvedOnly: input.approved_only,
      includeContradictions: input.include_contradictions,
    });
  },
});

export const archiveCollectionOperation = defineOperation({
  operationId: 'archiveCollection',
  method: 'POST',
  path: '/collections/{collectionId}/archive',
  summary: 'Archive a collection (reversible)',
  description: `Archives a collection. Member sources are not affected and remain in the library.

This is a high-risk action and requires a server-issued confirmation. This operation writes.`,
  tags: ['collections'],
  permission: 'collection.archive',
  scopes: ['collection.write'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({ collectionId: z.string().uuid() }),
  handler: (input, { ctx }) => archiveCollection(ctx, input.collectionId, input.confirmation_id),
});

export const restoreCollectionOperation = defineOperation({
  operationId: 'restoreCollection',
  method: 'POST',
  path: '/collections/{collectionId}/restore',
  summary: 'Restore an archived collection',
  description: 'Returns an archived collection to active status. This operation writes.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({ collectionId: z.string().uuid() }),
  handler: (input, { ctx }) => restoreCollection(ctx, input.collectionId),
});

export const refreshSmartCollectionOperation = defineOperation({
  operationId: 'refreshSmartCollection',
  method: 'POST',
  path: '/collections/{collectionId}/refresh',
  summary: 'Recompute a smart collection\'s membership from its rules',
  description:
    'Recomputes which sources belong to a smart collection based on its stored rules. Sources that no longer match are removed; new matches are added. This operation writes and only applies to collections configured with smart rules.',
  tags: ['collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({ collectionId: z.string().uuid() }),
  handler: (input, { ctx }) => refreshSmartCollection(ctx, input.collectionId),
});
