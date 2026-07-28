import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput, stringArray } from '../handler';
import {
  archiveSource,
  assignReviewer,
  bulkArchiveSources,
  bulkChangeReviewStatus,
  changeReviewStatus,
  compareSourceVersions,
  getRelatedSources,
  getSource,
  listSources,
  permanentlyDeleteSource,
  restoreSource,
  updateSource,
  updateSourceTaxonomy,
} from '../../services/source';
import {
  createManualSource,
  ingestIdentifier,
  ingestUrl,
  ingestUrlsBatch,
  reprocessSource,
} from '../../services/ingestion';
import { searchSourcePassages } from '../../services/search';
import { addSourcesToCollection, removeSourcesFromCollection } from '../../services/collection';

const duplicateBehavior = z
  .enum(['warn', 'return_existing', 'create_related', 'create_version_when_possible'])
  .describe(
    'warn returns DUPLICATE_SOURCE so you can ask the user; return_existing opens the existing record; create_related saves a linked copy; create_version_when_possible attaches a changed page as a new version.',
  );

export const listSourcesOperation = defineOperation({
  operationId: 'listSources',
  method: 'GET',
  path: '/sources',
  summary: 'List and filter library sources',
  description: `Returns a filtered, paginated list of sources with their review and processing state.

Use this for browsing and filtering -- "show sources awaiting review", "what did I add this week", "list everything in this collection". For relevance-ranked topic search use searchKnowledge instead; this operation does not rank by relevance to a question.

This operation does not modify anything.`,
  gptDescription:
    'Filtered, paginated browse of sources by review/processing state. For relevance-ranked topic search use searchKnowledge instead. Does not modify anything.',
  tags: ['sources'],
  permission: 'source.read',
  scopes: ['source.read', 'knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    query: z.string().optional(),
    review_status: stringArray.optional(),
    processing_status: stringArray.optional(),
    source_type: stringArray.optional(),
    category_id: z.string().uuid().optional(),
    tag_id: z.string().uuid().optional(),
    collection_id: z.string().uuid().optional(),
    publisher: z.string().optional(),
    author: z.string().optional(),
    published_after: z.string().optional(),
    published_before: z.string().optional(),
    added_by: z.string().uuid().optional(),
    assigned_reviewer_id: z.string().uuid().optional(),
    archived: z.coerce.boolean().optional(),
    duplicates_only: z.coerce.boolean().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: z.enum(['created_at', 'updated_at', 'publication_date', 'title']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  }),
  handler: async (input, { ctx }) => {
    const result = await listSources(ctx, {
      query: input.query,
      reviewStatus: input.review_status,
      processingStatus: input.processing_status,
      sourceType: input.source_type,
      categoryId: input.category_id,
      tagId: input.tag_id,
      collectionId: input.collection_id,
      publisher: input.publisher,
      author: input.author,
      publishedAfter: input.published_after,
      publishedBefore: input.published_before,
      addedBy: input.added_by,
      assignedReviewerId: input.assigned_reviewer_id,
      archived: input.archived,
      duplicatesOnly: input.duplicates_only,
      cursor: input.cursor,
      limit: input.limit,
      sort: input.sort,
      order: input.order,
    });
    return {
      items: result.items,
      pagination: { next_cursor: result.nextCursor, has_more: Boolean(result.nextCursor), limit: input.limit ?? 25 },
    };
  },
});

export const getSourceOperation = defineOperation({
  operationId: 'getSource',
  method: 'GET',
  path: '/sources/{sourceId}',
  summary: 'Get one source with its metadata, taxonomy and optional detail',
  description: `Returns the full record for one source: metadata, summaries, categories, tags, collections, review state and processing state.

Use this when a specific source has been identified and you need its details, or before proposing an edit. The optional include flags add study metadata, claims, annotations, versions and activity.

Full text is not returned by default and is truncated when requested; use searchSourcePassages to retrieve specific passages with locators rather than pulling the whole document.

This operation does not modify anything.`,
  gptDescription:
    'Full record for one source: metadata, review/processing state, and optionally study metadata, claims, annotations, versions, activity. Use searchSourcePassages for exact passages rather than full text. Does not modify anything.',
  tags: ['sources'],
  permission: 'source.read',
  scopes: ['source.read', 'knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    sourceId: z.string().uuid(),
    include_text: z.coerce.boolean().optional(),
    include_study_metadata: z.coerce.boolean().optional(),
    include_claims: z.coerce.boolean().optional(),
    include_annotations: z.coerce.boolean().optional(),
    include_versions: z.coerce.boolean().optional(),
    include_activity: z.coerce.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    getSource(ctx, input.sourceId, {
      includeText: input.include_text,
      includeStudyMetadata: input.include_study_metadata,
      includeClaims: input.include_claims,
      includeAnnotations: input.include_annotations,
      includeVersions: input.include_versions,
      includeActivity: input.include_activity,
    }),
});

export const searchSourcePassagesOperation = defineOperation({
  operationId: 'searchSourcePassages',
  method: 'POST',
  path: '/sources/{sourceId}/passages/search',
  summary: 'Find exact passages within one source',
  description: `Searches inside a single source and returns the best-matching passages with page numbers and locators.

Use this when the user wants an exact quotation, asks where a statement appears in a document, needs a page reference, or when you must verify a claim against its source before repeating it.

Never paraphrase a passage as if it were a quotation. Never invent a page number -- use the locator this returns. This operation does not modify anything.`,
  gptDescription:
    'Finds best-matching passages with page numbers/locators inside one source. Use for an exact quotation or to verify a claim before repeating it -- never paraphrase as a quotation or invent a page number. Does not modify anything.',
  tags: ['sources'],
  permission: 'source.read',
  scopes: ['source.read', 'knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    sourceId: z.string().uuid(),
    query: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(30).optional(),
    include_context: z.boolean().optional(),
  }),
  handler: (input, { ctx }) =>
    searchSourcePassages(ctx, input.sourceId, {
      query: input.query,
      limit: input.limit,
      includeContext: input.include_context,
    }),
});

export const ingestUrlOperation = defineOperation({
  operationId: 'ingestUrl',
  method: 'POST',
  path: '/sources/ingest-url',
  summary: 'Save one URL to the library and queue enrichment',
  description: `Fetches a URL, extracts its content, checks for duplicates, creates a source record and queues AI enrichment.

Use this when the user explicitly asks to save, log or add a link, or when an external research candidate has been chosen for saving. Do not call it speculatively for a URL the user merely mentioned.

The newly created source is approved immediately -- this deployment has no review queue. Extraction confidence and any extraction warnings still travel with the record, so mention them if they're present.

If a duplicate exists this returns DUPLICATE_SOURCE with the existing record; tell the user what already exists and ask whether to open it, save a related copy, or capture a new version. Do not silently create a second copy.

This operation writes. Supply an Idempotency-Key header to make a retry safe.`,
  gptDescription:
    "Fetches a URL, extracts content, checks duplicates, creates a source and queues enrichment. Approved immediately (no review queue) -- mention extraction warnings if present. On DUPLICATE_SOURCE, tell the user what exists and ask whether to open it, save related, or version it. Writes.",
  tags: ['sources', 'ingestion'],
  permission: 'source.create',
  scopes: ['source.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    url: z.string().min(1).describe('The URL to save.'),
    collection_ids: z.array(z.string().uuid()).optional(),
    category_ids: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().nullish(),
    assign_reviewer_id: z.string().uuid().nullish(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    duplicate_behavior: duplicateBehavior.optional(),
    processing_profile: z.enum(['standard', 'metadata_only', 'full']).optional(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
  }),
  examples: {
    request: {
      url: 'https://pubmed.ncbi.nlm.nih.gov/35449236/',
      tags: ['post-meal walking'],
      duplicate_behavior: 'warn',
    },
  },
  handler: (input, { ctx }) =>
    ingestUrl(ctx, {
      url: input.url,
      collectionIds: input.collection_ids,
      categoryIds: input.category_ids,
      tags: input.tags,
      notes: input.notes,
      assignReviewerId: input.assign_reviewer_id,
      priority: input.priority,
      duplicateBehavior: input.duplicate_behavior,
      processingProfile: input.processing_profile,
      visibility: input.visibility,
    }),
});

export const ingestUrlsBatchOperation = defineOperation({
  operationId: 'ingestUrlsBatch',
  method: 'POST',
  path: '/sources/ingest-batch',
  summary: 'Save several URLs with shared metadata',
  description: `Saves multiple URLs in one call, applying the same collections, categories and tags to each.

Use this when the user asks to save several links at once or has selected several research candidates. Each URL is reported separately as created, duplicate or failed -- report the failures, never just the successes.

Defaults to returning the existing record for duplicates rather than failing the whole batch. All created sources are approved immediately.

This operation writes. Batch size is capped by configuration.`,
  tags: ['sources', 'ingestion'],
  permission: 'source.create',
  scopes: ['source.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    urls: z.array(z.string().min(1)).min(1).max(50),
    collection_ids: z.array(z.string().uuid()).optional(),
    category_ids: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).optional(),
    duplicate_behavior: duplicateBehavior.optional(),
  }),
  handler: (input, { ctx }) =>
    ingestUrlsBatch(ctx, {
      urls: input.urls,
      collectionIds: input.collection_ids,
      categoryIds: input.category_ids,
      tags: input.tags,
      duplicateBehavior: input.duplicate_behavior,
    }),
});

export const ingestIdentifierOperation = defineOperation({
  operationId: 'ingestIdentifier',
  method: 'POST',
  path: '/sources/ingest-identifier',
  summary: 'Save a paper by DOI or PubMed identifier',
  description: `Resolves a DOI or PMID to its bibliographic record and landing page, then saves it as a source.

Use this when the user gives a DOI or PMID rather than a URL. If the identifier is already in the library the existing record is returned and nothing new is created.

This operation writes. The created source is approved immediately.`,
  gptDescription:
    'Resolves a DOI or PMID to its bibliographic record and saves it as a source. Returns the existing record if already in the library. Writes; approved immediately.',
  tags: ['sources', 'ingestion'],
  permission: 'source.create',
  scopes: ['source.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z
    .object({
      doi: z.string().optional(),
      pmid: z.string().optional(),
      collection_ids: z.array(z.string().uuid()).optional(),
      category_ids: z.array(z.string().uuid()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .refine((v) => v.doi || v.pmid, { message: 'Either doi or pmid is required.' }),
  handler: (input, { ctx }) =>
    ingestIdentifier(ctx, {
      doi: input.doi,
      pmid: input.pmid,
      collectionIds: input.collection_ids,
      categoryIds: input.category_ids,
      tags: input.tags,
    }),
});

export const createSourceOperation = defineOperation({
  operationId: 'createSource',
  method: 'POST',
  path: '/sources',
  summary: 'Create a source from supplied text rather than a URL',
  description: `Creates a source record from text you already have -- a manual note, pasted article text, an internal document, or a citation with no retrievable URL.

Use this when there is no URL to fetch, or when the publisher blocks automated access and the user has supplied the text. For a URL, use ingestUrl instead: it captures the original and its metadata.

This operation writes. The created source is approved immediately.`,
  gptDescription:
    'Creates a source from text you already have (pasted article, manual note, no fetchable URL). For a URL use ingestUrl instead. Writes; approved immediately.',
  tags: ['sources', 'ingestion'],
  permission: 'source.create',
  scopes: ['source.write'],
  riskLevel: 'low',
  idempotent: true,
  input: z.object({
    title: z.string().min(1),
    source_type: z.string().optional().describe('Defaults to manual_note.'),
    text: z.string().min(1),
    original_url: z.string().nullish(),
    authors: z.array(z.string()).optional(),
    publisher: z.string().nullish(),
    publication_date: z.string().nullish(),
    abstract: z.string().nullish(),
    categories: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
  }),
  handler: (input, { ctx }) =>
    createManualSource(ctx, {
      title: input.title,
      sourceType: input.source_type,
      text: input.text,
      originalUrl: input.original_url,
      authors: input.authors,
      publisher: input.publisher,
      publicationDate: input.publication_date,
      abstract: input.abstract,
      categoryIds: input.categories,
      tags: input.tags,
      collectionIds: input.collection_ids,
    }),
});

export const updateSourceOperation = defineOperation({
  operationId: 'updateSource',
  method: 'PATCH',
  path: '/sources/{sourceId}',
  summary: 'Correct editable metadata on a source',
  description: `Updates editable metadata fields on an existing source: title, authors, publisher, publication date, DOI, abstract, human summary, key findings, limitations, safety notes and similar.

Use this only when the user explicitly asks to correct or change source metadata.

This action does NOT change review status (use changeSourceReviewStatus), categories or tags (use updateSourceTaxonomy), or collection membership (use addSourceToCollections). Fields a reviewer has locked cannot be changed without the source.lock_fields permission.

Pass expected_version to detect a concurrent edit; a mismatch returns VERSION_CONFLICT rather than overwriting someone else's change.

This operation writes.`,
  gptDescription:
    'Updates editable metadata (title, authors, publisher, dates, abstract, summaries, findings, limitations) on an existing source. Does not change review status, taxonomy or collections -- use those dedicated operations. Locked fields need source.lock_fields. Writes.',
  tags: ['sources'],
  permission: 'source.update',
  scopes: ['source.write'],
  riskLevel: 'medium',
  input: z.object({
    sourceId: z.string().uuid(),
    expected_version: z.coerce.number().int().optional(),
    title: z.string().optional(),
    subtitle: z.string().nullish(),
    source_type: z.string().optional(),
    canonical_url: z.string().nullish(),
    doi: z.string().nullish(),
    pmid: z.string().nullish(),
    author_text: z.string().nullish(),
    publisher: z.string().nullish(),
    journal: z.string().nullish(),
    publication_date: z.string().nullish(),
    language: z.string().nullish(),
    country: z.string().nullish(),
    abstract: z.string().nullish(),
    human_summary: z.string().nullish(),
    evidence_summary: z.string().nullish(),
    key_findings: z.array(z.string()).optional(),
    limitations: z.array(z.string()).optional(),
    safety_notes: z.array(z.string()).optional(),
    practical_implications: z.array(z.string()).optional(),
    conflicts_of_interest: z.string().nullish(),
    funding_information: z.string().nullish(),
    visibility: z.enum(['private', 'restricted', 'organization', 'selected_collections']).optional(),
    retraction_status: z.string().optional(),
    retraction_reason: z.string().nullish(),
  }),
  handler: (input, { ctx }) => {
    const { sourceId, expected_version: expectedVersion, ...updates } = input;
    const defined = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    );
    return updateSource(ctx, sourceId, defined, { expectedVersion });
  },
});

export const updateSourceTaxonomyOperation = defineOperation({
  operationId: 'updateSourceTaxonomy',
  method: 'POST',
  path: '/sources/{sourceId}/taxonomy',
  summary: 'Add or remove categories and tags on a source',
  description: `Adds or removes category assignments and tags for one source.

Use this when the user asks to file a source under a category or to tag it. Categories must already exist -- use findSimilarCategories and createCategory first if the category is new. Tags are created on demand.

This action does not change review status or collection membership.

This operation writes.`,
  gptDescription:
    'Adds or removes categories and tags on a source. Categories must already exist -- use findSimilarCategories/createCategory first if new. Tags are created on demand. Does not change review status or collection membership. Writes.',
  tags: ['sources', 'taxonomy'],
  permission: 'source.update',
  scopes: ['source.write', 'taxonomy.write'],
  riskLevel: 'medium',
  input: z.object({
    sourceId: z.string().uuid(),
    add_category_ids: z.array(z.string().uuid()).optional(),
    remove_category_ids: z.array(z.string().uuid()).optional(),
    add_tags: z.array(z.string()).optional(),
    remove_tag_ids: z.array(z.string().uuid()).optional(),
  }),
  handler: (input, { ctx }) =>
    updateSourceTaxonomy(ctx, input.sourceId, {
      addCategoryIds: input.add_category_ids,
      removeCategoryIds: input.remove_category_ids,
      addTags: input.add_tags,
      removeTagIds: input.remove_tag_ids,
    }),
});

export const addSourceToCollectionsOperation = defineOperation({
  operationId: 'addSourceToCollections',
  method: 'POST',
  path: '/sources/{sourceId}/collections',
  summary: 'Add one source to one or more collections',
  description: `Adds a single source to the given collections, optionally recording why it was added.

Use this when the user asks to file an existing source into a collection. To add several sources to one collection, use addSourcesToCollection instead.

This operation writes.`,
  tags: ['sources', 'collections'],
  permission: 'collection.update',
  scopes: ['collection.write', 'source.write'],
  riskLevel: 'low',
  input: z.object({
    sourceId: z.string().uuid(),
    collection_ids: z.array(z.string().uuid()).min(1),
    reason_added: z.string().nullish(),
  }),
  handler: async (input, { ctx }) => {
    const results = [];
    for (const collectionId of input.collection_ids) {
      results.push({
        collection_id: collectionId,
        ...(await addSourcesToCollection(ctx, collectionId, {
          sourceIds: [input.sourceId],
          reasonAdded: input.reason_added,
        })),
      });
    }
    return { source_id: input.sourceId, collections: results };
  },
});

export const removeSourceFromCollectionsOperation = defineOperation({
  operationId: 'removeSourceFromCollections',
  method: 'DELETE',
  path: '/sources/{sourceId}/collections',
  summary: 'Remove one source from collections',
  description: `Removes a source from the given collections. The source itself is not deleted or archived and remains in the library.

Use this only when the user explicitly asks to take a source out of a collection. Be certain which collection is meant before calling.

This operation writes.`,
  tags: ['sources', 'collections'],
  permission: 'collection.update',
  scopes: ['collection.write'],
  riskLevel: 'medium',
  input: z.object({
    sourceId: z.string().uuid(),
    collection_ids: z.array(z.string().uuid()).min(1),
  }),
  handler: async (input, { ctx }) => {
    const results = [];
    for (const collectionId of input.collection_ids) {
      results.push({
        collection_id: collectionId,
        ...(await removeSourcesFromCollection(ctx, collectionId, [input.sourceId])),
      });
    }
    return { source_id: input.sourceId, collections: results };
  },
});

export const assignSourceReviewerOperation = defineOperation({
  operationId: 'assignSourceReviewer',
  method: 'POST',
  path: '/sources/{sourceId}/reviewer',
  summary: 'Assign a reviewer to a source',
  description: `Assigns a user to review a source and moves it into needs_review if it was unreviewed. An optional note is recorded as a review request annotation for the reviewer.

Use this when work is being handed to a specific person. This does not approve or reject anything.

This operation writes.`,
  tags: ['sources', 'review'],
  permission: 'source.update',
  scopes: ['source.write', 'source.review'],
  riskLevel: 'medium',
  input: z.object({
    sourceId: z.string().uuid(),
    reviewer_id: z.string().uuid(),
    note: z.string().optional(),
  }),
  handler: (input, { ctx }) =>
    assignReviewer(ctx, input.sourceId, input.reviewer_id, input.note),
});

export const changeSourceReviewStatusOperation = defineOperation({
  operationId: 'changeSourceReviewStatus',
  method: 'POST',
  path: '/sources/{sourceId}/review-status',
  summary: 'Approve, reject or otherwise change a source review status',
  description: `Changes the review status of one source: approved, approved_with_conditions, rejected, disputed, in_review, needs_review or superseded.

Use this only when the user, holding the relevant permission, explicitly decides on a source. Approving a source makes it count as organizational evidence, so never do it on your own initiative.

A reason is required to reject. Conditions are required for approved_with_conditions. Not every transition is allowed -- a rejected source must return to review before it can be approved. A source that is still processing cannot be approved.

For several sources at once use bulkChangeSourceReviewStatus, which requires confirmation.

This operation writes and requires the source.approve or source.reject permission.`,
  gptDescription:
    'Changes a source review status (approved/rejected/disputed/etc). Only call when the permitted user has explicitly decided -- approving makes it organizational evidence, never on your own initiative. Reason required to reject; conditions required for approved_with_conditions. Writes.',
  tags: ['sources', 'review'],
  scopes: ['source.review'],
  riskLevel: 'medium',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    sourceId: z.string().uuid(),
    status: z.enum([
      'unreviewed', 'needs_review', 'in_review', 'approved',
      'approved_with_conditions', 'rejected', 'disputed', 'superseded',
    ]),
    reason: z.string().optional().describe('Required when rejecting.'),
    conditions: z.array(z.string()).optional().describe('Required for approved_with_conditions.'),
    expected_version: z.coerce.number().int().optional(),
  }),
  handler: (input, { ctx }) =>
    changeReviewStatus(ctx, input.sourceId, {
      status: input.status,
      reason: input.reason,
      conditions: input.conditions,
      expectedVersion: input.expected_version,
      confirmationId: input.confirmation_id,
    }),
});

export const reprocessSourceOperation = defineOperation({
  operationId: 'reprocessSource',
  method: 'POST',
  path: '/sources/{sourceId}/reprocess',
  summary: 'Re-run AI enrichment stages for a source',
  description: `Queues selected enrichment stages to run again: summarize, classify, study_metadata, claims, embeddings, evidence_assessment.

Use this when extraction or enrichment produced poor results, after correcting the source text, or when a stage failed. Human summaries and reviewer-locked fields are never overwritten by a re-run, and human-verified study metadata is preserved.

Processing is asynchronous. Report that it is queued; do not report enriched results you have not retrieved.

This operation writes.`,
  tags: ['sources', 'processing'],
  permission: 'source.reprocess',
  scopes: ['source.write'],
  riskLevel: 'medium',
  input: z.object({
    sourceId: z.string().uuid(),
    stages: z
      .array(z.enum(['summarize', 'classify', 'study_metadata', 'claims', 'embeddings', 'evidence_assessment']))
      .optional(),
    reason: z.string().optional(),
  }),
  handler: (input, { ctx }) =>
    reprocessSource(ctx, input.sourceId, { stages: input.stages, reason: input.reason }),
});

export const archiveSourceOperation = defineOperation({
  operationId: 'archiveSource',
  method: 'POST',
  path: '/sources/{sourceId}/archive',
  summary: 'Archive a source (reversible)',
  description: `Archives a source so it no longer appears in default searches. The record, its passages, annotations and claim evidence are all kept, and restoreSource brings it back.

This is a high-risk action and requires a server-issued confirmation. Call requestActionConfirmation, show the user the exact summary it returns, obtain explicit agreement, call confirmAction, then retry this operation with the confirmation_id.

Archiving is NOT deletion. Never describe it as deleting or removing the source.

This operation writes.`,
  tags: ['sources'],
  permission: 'source.archive',
  scopes: ['source.write'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({ sourceId: z.string().uuid() }),
  handler: (input, { ctx }) => archiveSource(ctx, input.sourceId, input.confirmation_id),
});

export const restoreSourceOperation = defineOperation({
  operationId: 'restoreSource',
  method: 'POST',
  path: '/sources/{sourceId}/restore',
  summary: 'Restore an archived source',
  description: `Returns an archived source to the active library with its review status unchanged.

Use this when the user asks to bring back something that was archived. This operation writes.`,
  tags: ['sources'],
  permission: 'source.restore',
  scopes: ['source.write'],
  riskLevel: 'medium',
  input: z.object({ sourceId: z.string().uuid() }),
  handler: (input, { ctx }) => restoreSource(ctx, input.sourceId),
});

export const getRelatedSourcesOperation = defineOperation({
  operationId: 'getRelatedSources',
  method: 'GET',
  path: '/sources/{sourceId}/related',
  summary: 'Find sources related to this one',
  description: `Returns sources connected to this one through shared categories, shared collections or shared claim evidence, ranked by how strongly they are connected.

Use this to help a user explore around a source. This operation does not modify anything.`,
  tags: ['sources'],
  permission: 'source.read',
  scopes: ['source.read', 'knowledge.read'],
  riskLevel: 'low',
  input: z.object({
    sourceId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
  handler: (input, { ctx }) => getRelatedSources(ctx, input.sourceId, input.limit),
});

export const compareSourceVersionsOperation = defineOperation({
  operationId: 'compareSourceVersions',
  method: 'GET',
  path: '/sources/{sourceId}/versions/compare',
  summary: 'Compare two captured versions of a source',
  description: `Compares two stored versions of a source and reports whether the content or title changed, which lines were added or removed, and which metadata fields differ.

Use this when a page has been re-captured and the user wants to know what changed. This operation does not modify anything.`,
  tags: ['sources'],
  permission: 'source.read',
  scopes: ['source.read'],
  riskLevel: 'low',
  input: z.object({
    sourceId: z.string().uuid(),
    from_version: z.coerce.number().int().min(1),
    to_version: z.coerce.number().int().min(1),
  }),
  handler: (input, { ctx }) =>
    compareSourceVersions(ctx, input.sourceId, input.from_version, input.to_version),
});

export const bulkChangeSourceReviewStatusOperation = defineOperation({
  operationId: 'bulkChangeSourceReviewStatus',
  method: 'POST',
  path: '/sources/bulk/review-status',
  summary: 'Change the review status of several sources at once',
  description: `Applies one review-status change across a set of sources, reporting each record's outcome separately.

This is a high-risk action and requires a server-issued confirmation covering the exact set of source ids. Bulk approval in particular turns many records into organizational evidence at once, so state the count and let the user confirm.

Never use a vague selection such as "all relevant sources". Resolve the exact ids first, and report any records that failed.

This operation writes.`,
  tags: ['sources', 'review'],
  scopes: ['source.review'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    source_ids: z.array(z.string().uuid()).min(1).max(200),
    status: z.enum([
      'needs_review', 'in_review', 'approved', 'approved_with_conditions', 'rejected', 'disputed',
    ]),
    reason: z.string().optional(),
  }),
  handler: (input, { ctx }) =>
    bulkChangeReviewStatus(ctx, {
      sourceIds: input.source_ids,
      status: input.status,
      reason: input.reason,
      confirmationId: input.confirmation_id,
    }),
});

export const bulkArchiveSourcesOperation = defineOperation({
  operationId: 'bulkArchiveSources',
  method: 'POST',
  path: '/sources/bulk/archive',
  summary: 'Archive several sources at once',
  description: `Archives a set of sources, reporting each record's outcome separately. Archiving is reversible; each source can be restored individually.

This is a high-risk action and requires a server-issued confirmation covering the exact set of source ids.

This operation writes.`,
  tags: ['sources'],
  permission: 'source.archive',
  scopes: ['source.write'],
  riskLevel: 'high',
  mayRequireConfirmation: true,
  input: ConfirmationInput.extend({
    source_ids: z.array(z.string().uuid()).min(1).max(200),
  }),
  handler: (input, { ctx }) =>
    bulkArchiveSources(ctx, {
      sourceIds: input.source_ids,
      confirmationId: input.confirmation_id,
    }),
});

export const permanentlyDeleteSourceOperation = defineOperation({
  operationId: 'permanentlyDeleteSource',
  method: 'DELETE',
  path: '/sources/{sourceId}',
  summary: 'Permanently delete an archived source (administrators only)',
  description: `Permanently destroys a source and everything attached to it: passages, annotations, claim evidence and versions. This cannot be undone.

Only archived sources can be deleted, so a record must be archived first. Requires the source.delete_permanent permission and a server-issued confirmation.

Prefer archiveSource in almost every case. Only proceed when an administrator has explicitly and unambiguously asked for permanent deletion of a specific record.

This operation is excluded from the Custom GPT action schema by default.`,
  tags: ['sources', 'admin'],
  permission: 'source.delete_permanent',
  scopes: [],
  riskLevel: 'critical',
  mayRequireConfirmation: true,
  internalOnly: true,
  input: ConfirmationInput.extend({ sourceId: z.string().uuid() }),
  handler: (input, { ctx }) => permanentlyDeleteSource(ctx, input.sourceId, input.confirmation_id),
});
