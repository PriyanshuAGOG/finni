# API Scope Matrix

Generated from `src/domain/permissions.ts` and the operation registry by `npm run docs:generate`. Do not hand-edit.

## How authorization is decided

Every request is authorized by the **intersection** of two independent checks:

1. **Permission** — does the acting user's role (plus any per-user override) grant the permission the operation requires?
2. **Scope** — for a scoped credential (OAuth token or API-key prototype), does it carry a scope that unlocks that permission? A first-party dashboard session is not scope-limited.

A broadly-scoped Custom GPT token therefore still cannot exceed what its underlying user could do in the dashboard, and a narrowly-scoped token cannot be used to reach past its own grant even for a highly privileged user.

## OAuth scopes → permissions unlocked

| Scope | Permissions it can unlock |
| --- | --- |
| `profile.read` | _(no permissions unlocked — read-only identity scope)_ |
| `knowledge.read` | `knowledge.read`, `source.read` |
| `source.read` | `source.read` |
| `source.write` | `source.create`, `source.update`, `source.reprocess`, `source.archive`, `source.restore` |
| `source.review` | `source.approve`, `source.reject`, `source.lock_fields` |
| `collection.read` | `collection.read` |
| `collection.write` | `collection.create`, `collection.update`, `collection.archive`, `collection.manage_members` |
| `taxonomy.read` | `taxonomy.read` |
| `taxonomy.write` | `taxonomy.create`, `taxonomy.update`, `taxonomy.merge`, `taxonomy.archive` |
| `claim.read` | `claim.read` |
| `claim.write` | `claim.create`, `claim.update`, `claim.archive` |
| `claim.review` | `claim.review` |
| `annotation.read` | `annotation.read` |
| `annotation.write` | `annotation.create`, `annotation.update_own`, `annotation.update_any`, `annotation.delete_own`, `annotation.delete_any` |
| `research.run` | `research.run` |
| `brief.read` | `brief.read` |
| `brief.write` | `brief.create`, `brief.update`, `brief.approve` |
| `content.generate` | `content.generate`, `content.approve` |
| `audit.read` | `audit.read` |
| `admin.integrations` | `integration.manage` |

## Scope usage across operations

| Scope | Operations that accept it | Examples |
| --- | --- | --- |
| `annotation.read` | 1 | `listAnnotations` |
| `annotation.write` | 4 | `createAnnotation`, `updateAnnotation`, `resolveAnnotation`, `archiveAnnotation` |
| `audit.read` | 2 | `listAuditEvents`, `getResourceActivity` |
| `brief.read` | 3 | `listResearchBriefs`, `getResearchBrief`, `exportResearchBrief` |
| `brief.write` | 6 | `createResearchBrief`, `generateResearchBrief`, `updateResearchBrief`, `updateBriefSources`, `submitBriefForReview`, `approveResearchBrief` |
| `claim.read` | 3 | `searchClaims`, `getClaim`, `analyzeClaimConflicts` |
| `claim.review` | 1 | `reviewClaim` |
| `claim.write` | 6 | `createClaim`, `updateClaim`, `addClaimEvidence`, `removeClaimEvidence`, `archiveClaim`, `restoreClaim` |
| `collection.read` | 4 | `listCollections`, `getCollection`, `findSimilarCollections`, `synthesizeCollection` |
| `collection.write` | 10 | `addSourceToCollections`, `removeSourceFromCollections`, `createCollection`, `updateCollection`, `addSourcesToCollection`, `removeSourcesFromCollection`, … |
| `content.generate` | 5 | `generateEvidenceBasedContent`, `getGeneratedContent`, `updateGeneratedContent`, `regenerateContentSection`, `validateContentCitations` |
| `knowledge.read` | 10 | `searchKnowledge`, `synthesizeKnowledge`, `findEvidence`, `compareSources`, `findKnowledgeGaps`, `listSources`, … |
| `profile.read` | 1 | `getCurrentUser` |
| `research.run` | 8 | `previewExternalResearch`, `previewExternalSource`, `startResearchJob`, `getResearchJob`, `listResearchJobs`, `listResearchCandidates`, … |
| `source.read` | 7 | `listSources`, `getSource`, `searchSourcePassages`, `getRelatedSources`, `compareSourceVersions`, `getProcessingJob`, … |
| `source.review` | 3 | `assignSourceReviewer`, `changeSourceReviewStatus`, `bulkChangeSourceReviewStatus` |
| `source.write` | 15 | `ingestUrl`, `ingestUrlsBatch`, `ingestIdentifier`, `createSource`, `updateSource`, `updateSourceTaxonomy`, … |
| `taxonomy.read` | 4 | `listCategories`, `findSimilarCategories`, `previewCategoryMerge`, `listTags` |
| `taxonomy.write` | 9 | `updateSourceTaxonomy`, `createCategory`, `updateCategory`, `moveCategory`, `mergeCategories`, `archiveCategory`, … |

## System roles → permission counts

- **Administrator** (`administrator`): 45 permissions — Full control of the organization, including users, roles, integrations, taxonomy, retention and permanent deletion.
- **Research manager** (`research_manager`): 36 permissions — Runs the research operation: manages sources and collections, approves sources, assigns review work and generates briefs.
- **Researcher** (`researcher`): 22 permissions — Adds and organizes sources, annotates, runs searches and research jobs, and submits work for review.
- **Clinical reviewer** (`clinical_reviewer`): 20 permissions — Reviews health claims, corrects evidence classifications, adds safety qualifications and locks reviewed fields.
- **Content team member** (`content_team`): 16 permissions — Searches approved evidence, drafts content and briefs, and requests research. Cannot approve clinical claims.
- **Viewer** (`viewer`): 7 permissions — Reads approved knowledge and exports permitted citations. Cannot modify records.

See `src/domain/permissions.ts` for the full permission list and `docs/action-risk-matrix.md` for which operations additionally require a server-issued confirmation regardless of permission or scope.
