import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput } from '../handler';
import {
  archiveCategory,
  createCategory,
  createTag,
  findSimilarCategories,
  listCategories,
  listTags,
  mergeCategories,
  mergeTags,
  moveCategory,
  previewCategoryMerge,
  restoreCategory,
  updateCategory,
} from '../../services/taxonomy';

export const listCategoriesOperation = defineOperation({
  operationId: 'listCategories',
  method: 'GET',
  path: '/categories',
  summary: 'List the category taxonomy',
  description:
    'Returns categories, optionally as a nested tree, with usage counts. Use this to browse or check the existing taxonomy before creating a category. This operation does not modify anything.',
  tags: ['taxonomy'],
  permission: 'taxonomy.read',
  scopes: ['taxonomy.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().optional(),
    parent_id: z.string().uuid().nullish(),
    include_archived: z.coerce.boolean().optional(),
    include_usage_counts: z.coerce.boolean().optional(),
    tree: z.coerce.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    listCategories(ctx, {
      query: input.query,
      parentId: input.parent_id,
      includeArchived: input.include_archived,
      includeUsageCounts: input.include_usage_counts,
      tree: input.tree,
    }),
});

export const findSimilarCategoriesOperation = defineOperation({
  operationId: 'findSimilarCategories',
  method: 'GET',
  path: '/categories/similar',
  summary: 'Find categories that would overlap with a proposed name',
  description: `Checks whether a proposed category name (and optional parent) is a likely duplicate of an existing one, comparing normalized names and declared synonyms.

Call this before createCategory whenever the user asks to create a category. A similarity of 0.9 or higher generally means an existing category should be used instead. This operation does not modify anything.`,
  gptDescription:
    "Checks whether a proposed category name/parent duplicates an existing one. Call before createCategory. Similarity >=0.9 generally means use the existing category instead. Does not modify anything.",
  tags: ['taxonomy'],
  permission: 'taxonomy.read',
  scopes: ['taxonomy.read'],
  riskLevel: 'low',
  input: z.object({
    name: z.string().min(1),
    parent_category_id: z.string().uuid().nullish(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
  }),
  handler: (input, { ctx }) =>
    findSimilarCategories(ctx, {
      name: input.name,
      parentCategoryId: input.parent_category_id,
      limit: input.limit,
    }),
});

export const createCategoryOperation = defineOperation({
  operationId: 'createCategory',
  method: 'POST',
  path: '/categories',
  summary: 'Create a new taxonomy category',
  description: `Creates a category in the controlled taxonomy.

Always call findSimilarCategories first. If a likely duplicate exists (similarity 0.9+), do not create a new category -- tell the user what already exists and recommend using it, unless they explicitly confirm a genuinely distinct category is needed. If they confirm, retry with allow_duplicate set to true.

If a duplicate exists and allow_duplicate is not set, this returns CONFLICT with the matching categories rather than creating a near-duplicate silently.

This operation writes.`,
  gptDescription:
    "Creates a taxonomy category. Always call findSimilarCategories first -- if a likely duplicate exists (>=0.9), recommend it instead unless the user explicitly confirms a distinct category is needed (allow_duplicate: true). Writes.",
  tags: ['taxonomy'],
  permission: 'taxonomy.create',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  idempotent: true,
  input: z.object({
    name: z.string().min(1),
    description: z.string().nullish(),
    parent_category_id: z.string().uuid().nullish(),
    synonyms: z.array(z.string()).optional(),
    color: z.string().nullish(),
    icon: z.string().nullish(),
    ai_usage_guidance: z.string().nullish(),
    allow_duplicate: z.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    createCategory(ctx, {
      name: input.name,
      description: input.description,
      parentCategoryId: input.parent_category_id,
      synonyms: input.synonyms,
      color: input.color,
      icon: input.icon,
      aiUsageGuidance: input.ai_usage_guidance,
      allowDuplicate: input.allow_duplicate,
    }),
});

export const updateCategoryOperation = defineOperation({
  operationId: 'updateCategory',
  method: 'PATCH',
  path: '/categories/{categoryId}',
  summary: 'Update a category\'s metadata',
  description:
    'Updates a category\'s name, description, synonyms, color, icon or AI usage guidance. Does not move it in the hierarchy -- use moveCategory for that. This operation writes.',
  tags: ['taxonomy'],
  permission: 'taxonomy.update',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  input: z.object({
    categoryId: z.string().uuid(),
    name: z.string().optional(),
    description: z.string().nullish(),
    synonyms: z.array(z.string()).optional(),
    color: z.string().nullish(),
    icon: z.string().nullish(),
    ai_usage_guidance: z.string().nullish(),
  }),
  handler: (input, { ctx }) =>
    updateCategory(ctx, input.categoryId, {
      name: input.name,
      description: input.description,
      synonyms: input.synonyms,
      color: input.color,
      icon: input.icon,
      aiUsageGuidance: input.ai_usage_guidance,
    }),
});

export const moveCategoryOperation = defineOperation({
  operationId: 'moveCategory',
  method: 'POST',
  path: '/categories/{categoryId}/move',
  summary: 'Move a category to a new parent',
  description:
    'Reassigns a category\'s parent. Refuses a move that would create a circular hierarchy. Pass null to move it to the root. This operation writes.',
  tags: ['taxonomy'],
  permission: 'taxonomy.update',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  input: z.object({
    categoryId: z.string().uuid(),
    new_parent_category_id: z.string().uuid().nullable(),
  }),
  handler: (input, { ctx }) => moveCategory(ctx, input.categoryId, input.new_parent_category_id),
});

export const previewCategoryMergeOperation = defineOperation({
  operationId: 'previewCategoryMerge',
  method: 'POST',
  path: '/categories/merge-preview',
  summary: 'Preview the effect of merging categories before confirming',
  description:
    'Reports how many source assignments and child categories would move if the given categories were merged into the target, without changing anything. Use this to build the human summary before requesting confirmation for mergeCategories. This operation does not modify anything.',
  tags: ['taxonomy'],
  permission: 'taxonomy.read',
  scopes: ['taxonomy.read'],
  riskLevel: 'low',
  input: z.object({
    source_category_ids: z.array(z.string().uuid()).min(1),
    target_category_id: z.string().uuid(),
  }),
  handler: (input, { ctx }) =>
    previewCategoryMerge(ctx, {
      sourceCategoryIds: input.source_category_ids,
      targetCategoryId: input.target_category_id,
    }),
});

export const mergeCategoriesOperation = defineOperation({
  operationId: 'mergeCategories',
  method: 'POST',
  path: '/categories/merge',
  summary: 'Merge categories into one target category',
  description: `Merges one or more categories into a target: source assignments and child categories move to the target, the merged-away names become synonyms of it, and the merged categories are archived (not deleted).

This is a high-risk, hard-to-reverse action and requires a server-issued confirmation. Call previewCategoryMerge first to build an accurate summary, then requestActionConfirmation, obtain explicit agreement, call confirmAction, then retry this operation.

This operation writes.`,
  tags: ['taxonomy'],
  permission: 'taxonomy.merge',
  scopes: ['taxonomy.write'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    source_category_ids: z.array(z.string().uuid()).min(1),
    target_category_id: z.string().uuid(),
    preserve_source_names_as_synonyms: z.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    mergeCategories(ctx, {
      sourceCategoryIds: input.source_category_ids,
      targetCategoryId: input.target_category_id,
      preserveSourceNamesAsSynonyms: input.preserve_source_names_as_synonyms,
      confirmationId: input.confirmation_id,
    }),
});

export const archiveCategoryOperation = defineOperation({
  operationId: 'archiveCategory',
  method: 'POST',
  path: '/categories/{categoryId}/archive',
  summary: 'Archive a category (reversible)',
  description: `Archives a category. Existing source assignments are kept. A category cannot be archived while it has active child categories -- move or archive them first.

Archiving a category used by more than a configured number of sources requires a server-issued confirmation; a lightly used category may archive directly. This operation writes.`,
  tags: ['taxonomy'],
  permission: 'taxonomy.archive',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({ categoryId: z.string().uuid() }),
  handler: (input, { ctx }) => archiveCategory(ctx, input.categoryId, input.confirmation_id),
});

export const restoreCategoryOperation = defineOperation({
  operationId: 'restoreCategory',
  method: 'POST',
  path: '/categories/{categoryId}/restore',
  summary: 'Restore an archived category',
  description:
    'Returns an archived category to active status. Refuses if the category was merged into another, since restoring it would recreate the duplicate the merge resolved. This operation writes.',
  tags: ['taxonomy'],
  permission: 'taxonomy.update',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  input: z.object({ categoryId: z.string().uuid() }),
  handler: (input, { ctx }) => restoreCategory(ctx, input.categoryId),
});

export const listTagsOperation = defineOperation({
  operationId: 'listTags',
  method: 'GET',
  path: '/tags',
  summary: 'List and search tags',
  description: 'Returns tags ordered by usage. This operation does not modify anything.',
  tags: ['taxonomy'],
  permission: 'taxonomy.read',
  scopes: ['taxonomy.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    include_archived: z.coerce.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    listTags(ctx, { query: input.query, limit: input.limit, includeArchived: input.include_archived }),
});

export const createTagOperation = defineOperation({
  operationId: 'createTag',
  method: 'POST',
  path: '/tags',
  summary: 'Create a tag',
  description:
    'Creates a tag, or returns the existing one if an equivalent name already exists -- tags are lighter-weight than categories and are not blocked on near-duplicates. This operation writes.',
  tags: ['taxonomy'],
  permission: 'taxonomy.create',
  scopes: ['taxonomy.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({ name: z.string().min(1), description: z.string().nullish() }),
  handler: (input, { ctx }) => createTag(ctx, { name: input.name, description: input.description }),
});

export const mergeTagsOperation = defineOperation({
  operationId: 'mergeTags',
  method: 'POST',
  path: '/tags/merge',
  summary: 'Merge tags into one target tag',
  description: `Merges the given tags into the target: assignments move, and the merged tags are marked merged rather than deleted.

A large merge (affecting many source assignments) requires a server-issued confirmation; a small merge may proceed directly. This operation writes.`,
  tags: ['taxonomy'],
  permission: 'taxonomy.merge',
  scopes: ['taxonomy.write'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    source_tag_ids: z.array(z.string().uuid()).min(1),
    target_tag_id: z.string().uuid(),
  }),
  handler: (input, { ctx }) =>
    mergeTags(ctx, {
      sourceTagIds: input.source_tag_ids,
      targetTagId: input.target_tag_id,
      confirmationId: input.confirmation_id,
    }),
});
