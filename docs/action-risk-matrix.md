# Action Risk Matrix

Generated from the operation registry (`src/api/operations/*.ts`) by `npm run docs:generate`. Do not hand-edit — edit the operation definitions and regenerate.

Risk tiers, as enforced by `src/domain/risk.ts`:

- **low** — read-only or additive and easily undone. Executes without confirmation.
- **medium** — needs clear intent; executes in the same turn.
- **high** — requires a server-issued confirmation (`requestActionConfirmation` → `confirmAction` → retry with `confirmation_id`).
- **critical** — administrators only, always confirmed. Several are excluded from the default Custom GPT action set (see "Internal only").

Some operations escalate risk dynamically (a batch above the configured threshold, or editing an approved/safety-relevant claim) — see `src/domain/risk.ts` `RISK_MATRIX` for the exact conditions; the table below shows the *baseline* level for a single, non-escalated call.

| Operation ID | Route | Risk | May require confirmation | Required permission | Internal only |
| --- | --- | --- | --- | --- | --- |
| `createApiClient` | POST `/admin/api-clients` | **critical** | — | integration.manage | Yes |
| `permanentlyDeleteSource` | DELETE `/sources/{sourceId}` | **critical** | Yes | source.delete_permanent | Yes |
| `revokeApiClient` | POST `/admin/api-clients/{clientId}/revoke` | **critical** | Yes | integration.manage | Yes |
| `archiveClaim` | POST `/claims/{claimId}/archive` | **high** | Yes | claim.archive | — |
| `archiveCollection` | POST `/collections/{collectionId}/archive` | **high** | Yes | collection.archive | — |
| `archiveSource` | POST `/sources/{sourceId}/archive` | **high** | Yes | source.archive | — |
| `bulkArchiveSources` | POST `/sources/bulk/archive` | **high** | Yes | source.archive | — |
| `bulkChangeSourceReviewStatus` | POST `/sources/bulk/review-status` | **high** | Yes | — | — |
| `mergeCategories` | POST `/categories/merge` | **high** | Yes | taxonomy.merge | — |
| `approveResearchBrief` | POST `/briefs/{briefId}/approve` | **medium** | — | brief.approve | — |
| `archiveAnnotation` | POST `/annotations/{annotationId}/archive` | **medium** | — | — | — |
| `archiveCategory` | POST `/categories/{categoryId}/archive` | **medium** | Yes | taxonomy.archive | — |
| `assignSourceReviewer` | POST `/sources/{sourceId}/reviewer` | **medium** | — | source.update | — |
| `cancelResearchJob` | POST `/research-jobs/{researchJobId}/cancel` | **medium** | Yes | research.run | — |
| `changeSourceReviewStatus` | POST `/sources/{sourceId}/review-status` | **medium** | Yes | — | — |
| `createCategory` | POST `/categories` | **medium** | — | taxonomy.create | — |
| `inviteMember` | POST `/team/invitations` | **medium** | — | user.manage | Yes |
| `mergeTags` | POST `/tags/merge` | **medium** | Yes | taxonomy.merge | — |
| `moveCategory` | POST `/categories/{categoryId}/move` | **medium** | — | taxonomy.update | — |
| `refreshSmartCollection` | POST `/collections/{collectionId}/refresh` | **medium** | — | collection.update | — |
| `regenerateContentSection` | POST `/content/{contentId}/regenerate-section` | **medium** | — | content.generate | — |
| `removeClaimEvidence` | DELETE `/claims/{claimId}/evidence/{evidenceId}` | **medium** | Yes | claim.update | — |
| `removeSourceFromCollections` | DELETE `/sources/{sourceId}/collections` | **medium** | — | collection.update | — |
| `removeSourcesFromCollection` | DELETE `/collections/{collectionId}/sources` | **medium** | — | collection.update | — |
| `reorderCollectionSources` | POST `/collections/{collectionId}/sources/reorder` | **medium** | — | collection.update | — |
| `reprocessSource` | POST `/sources/{sourceId}/reprocess` | **medium** | — | source.reprocess | — |
| `resolveAnnotation` | POST `/annotations/{annotationId}/resolve` | **medium** | — | — | — |
| `restoreCategory` | POST `/categories/{categoryId}/restore` | **medium** | — | taxonomy.update | — |
| `restoreClaim` | POST `/claims/{claimId}/restore` | **medium** | — | claim.update | — |
| `restoreCollection` | POST `/collections/{collectionId}/restore` | **medium** | — | collection.update | — |
| `restoreSource` | POST `/sources/{sourceId}/restore` | **medium** | — | source.restore | — |
| `reviewClaim` | POST `/claims/{claimId}/review` | **medium** | — | claim.review | — |
| `revokeInvitation` | POST `/team/invitations/{invitationId}/revoke` | **medium** | — | user.manage | Yes |
| `submitBriefForReview` | POST `/briefs/{briefId}/submit-review` | **medium** | — | brief.update | — |
| `updateAnnotation` | PATCH `/annotations/{annotationId}` | **medium** | — | — | — |
| `updateBriefSources` | POST `/briefs/{briefId}/sources` | **medium** | — | brief.update | — |
| `updateCategory` | PATCH `/categories/{categoryId}` | **medium** | — | taxonomy.update | — |
| `updateClaim` | PATCH `/claims/{claimId}` | **medium** | Yes | claim.update | — |
| `updateCollection` | PATCH `/collections/{collectionId}` | **medium** | — | collection.update | — |
| `updateGeneratedContent` | PATCH `/content/{contentId}` | **medium** | — | content.generate | — |
| `updateResearchBrief` | PATCH `/briefs/{briefId}` | **medium** | — | brief.update | — |
| `updateSource` | PATCH `/sources/{sourceId}` | **medium** | — | source.update | — |
| `updateSourceTaxonomy` | POST `/sources/{sourceId}/taxonomy` | **medium** | — | source.update | — |
| `addClaimEvidence` | POST `/claims/{claimId}/evidence` | **low** | — | claim.update | — |
| `addSourcesToCollection` | POST `/collections/{collectionId}/sources` | **low** | — | collection.update | — |
| `addSourceToCollections` | POST `/sources/{sourceId}/collections` | **low** | — | collection.update | — |
| `analyzeClaimConflicts` | POST `/claims/{claimId}/analyze-conflicts` | **low** | — | claim.read | — |
| `compareSources` | POST `/knowledge/compare` | **low** | — | knowledge.read | — |
| `compareSourceVersions` | GET `/sources/{sourceId}/versions/compare` | **low** | — | source.read | — |
| `confirmAction` | POST `/confirmations/{confirmationId}/confirm` | **low** | — | — | — |
| `createAnnotation` | POST `/annotations` | **low** | — | annotation.create | — |
| `createClaim` | POST `/claims` | **low** | — | claim.create | — |
| `createCollection` | POST `/collections` | **low** | — | collection.create | — |
| `createResearchBrief` | POST `/briefs` | **low** | — | brief.create | — |
| `createSource` | POST `/sources` | **low** | — | source.create | — |
| `createTag` | POST `/tags` | **low** | — | taxonomy.create | — |
| `exportResearchBrief` | GET `/briefs/{briefId}/export` | **low** | — | brief.read | — |
| `findEvidence` | POST `/knowledge/evidence` | **low** | — | knowledge.read | — |
| `findKnowledgeGaps` | POST `/knowledge/gaps` | **low** | — | knowledge.read | — |
| `findSimilarCategories` | GET `/categories/similar` | **low** | — | taxonomy.read | — |
| `findSimilarCollections` | GET `/collections/similar` | **low** | — | collection.read | — |
| `generateEvidenceBasedContent` | POST `/content/generate` | **low** | — | content.generate | — |
| `generateResearchBrief` | POST `/briefs/{briefId}/generate` | **low** | — | brief.update | — |
| `getClaim` | GET `/claims/{claimId}` | **low** | — | claim.read | — |
| `getCollection` | GET `/collections/{collectionId}` | **low** | — | collection.read | — |
| `getConfirmationStatus` | GET `/confirmations/{confirmationId}` | **low** | — | — | — |
| `getCurrentUser` | GET `/me` | **low** | — | — | — |
| `getGeneratedContent` | GET `/content/{contentId}` | **low** | — | content.generate | — |
| `getMyActionHistory` | GET `/audit/my-actions` | **low** | — | — | — |
| `getProcessingJob` | GET `/processing-jobs/{jobId}` | **low** | — | source.read | — |
| `getQueueHealth` | GET `/admin/queue-health` | **low** | — | audit.read | Yes |
| `getRelatedSources` | GET `/sources/{sourceId}/related` | **low** | — | source.read | — |
| `getResearchBrief` | GET `/briefs/{briefId}` | **low** | — | brief.read | — |
| `getResearchJob` | GET `/research-jobs/{researchJobId}` | **low** | — | research.run | — |
| `getResourceActivity` | GET `/audit/resource/{resourceType}/{resourceId}` | **low** | — | audit.read | — |
| `getSource` | GET `/sources/{sourceId}` | **low** | — | source.read | — |
| `ingestFile` | POST `/sources/ingest-file` | **low** | — | source.create | Yes |
| `ingestIdentifier` | POST `/sources/ingest-identifier` | **low** | — | source.create | — |
| `ingestUrl` | POST `/sources/ingest-url` | **low** | — | source.create | — |
| `ingestUrlsBatch` | POST `/sources/ingest-batch` | **low** | — | source.create | — |
| `listAnnotations` | GET `/annotations` | **low** | — | annotation.read | — |
| `listAuditEvents` | GET `/audit` | **low** | — | audit.read | — |
| `listCategories` | GET `/categories` | **low** | — | taxonomy.read | — |
| `listCollections` | GET `/collections` | **low** | — | collection.read | — |
| `listIntegrations` | GET `/admin/integrations` | **low** | — | integration.manage | Yes |
| `listMembers` | GET `/team/members` | **low** | — | — | Yes |
| `listPendingInvitations` | GET `/team/invitations` | **low** | — | user.manage | Yes |
| `listProcessingJobs` | GET `/processing-jobs` | **low** | — | source.read | — |
| `listResearchBriefs` | GET `/briefs` | **low** | — | brief.read | — |
| `listResearchCandidates` | GET `/research-jobs/{researchJobId}/candidates` | **low** | — | research.run | — |
| `listResearchJobs` | GET `/research-jobs` | **low** | — | research.run | — |
| `listSources` | GET `/sources` | **low** | — | source.read | — |
| `listTags` | GET `/tags` | **low** | — | taxonomy.read | — |
| `previewCategoryMerge` | POST `/categories/merge-preview` | **low** | — | taxonomy.read | — |
| `previewExternalResearch` | POST `/research-jobs/preview` | **low** | — | research.run | — |
| `previewExternalSource` | POST `/research-jobs/source-preview` | **low** | — | research.run | — |
| `requestActionConfirmation` | POST `/confirmations` | **low** | — | — | — |
| `retryProcessingJob` | POST `/processing-jobs/{jobId}/retry` | **low** | — | source.reprocess | — |
| `searchClaims` | POST `/claims/search` | **low** | — | claim.read | — |
| `searchKnowledge` | POST `/knowledge/search` | **low** | — | knowledge.read | — |
| `searchSourcePassages` | POST `/sources/{sourceId}/passages/search` | **low** | — | source.read | — |
| `selectResearchCandidates` | POST `/research-jobs/{researchJobId}/candidates/select` | **low** | — | research.run | — |
| `startResearchJob` | POST `/research-jobs` | **low** | — | research.run | — |
| `synthesizeCollection` | POST `/collections/{collectionId}/synthesize` | **low** | — | knowledge.read | — |
| `synthesizeKnowledge` | POST `/knowledge/synthesize` | **low** | — | knowledge.read | — |
| `validateContentCitations` | POST `/content/{contentId}/validate` | **low** | — | content.generate | — |
