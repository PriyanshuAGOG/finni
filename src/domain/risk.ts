import { getEnv } from '../lib/env';

/**
 * Action risk matrix.
 *
 * This is the authoritative copy. The Custom GPT instructions describe the
 * same tiers, but the GPT's cooperation is not what enforces them -- the
 * API refuses a high-risk call without a valid server-issued confirmation
 * regardless of what the model believes it was told.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskRule {
  /** Baseline tier when the operation affects a single record. */
  level: RiskLevel;
  /** Human phrase the user must type back to confirm. */
  phrase?: string;
  /**
   * Escalation: an operation that is medium risk for one record can be
   * high risk across many. Returns the effective level for a batch.
   */
  escalate?: (ctx: RiskContext) => RiskLevel;
  notes?: string;
}

export interface RiskContext {
  /** Number of records the call would change. */
  affectedCount?: number;
  /** Whether the target is already approved (clinical records are stricter). */
  targetApproved?: boolean;
  /** Whether the target carries clinical safety relevance. */
  safetyRelevant?: boolean;
  /** Usage count for taxonomy archive decisions. */
  usageCount?: number;
}

const bulkEscalation = (base: RiskLevel) => (ctx: RiskContext): RiskLevel => {
  const threshold = getEnv().BULK_CONFIRM_THRESHOLD;
  return (ctx.affectedCount ?? 1) > threshold ? 'high' : base;
};

export const RISK_MATRIX: Record<string, RiskRule> = {
  // ---- low: read-only or additive and easily undone -------------------
  searchKnowledge: { level: 'low' },
  synthesizeKnowledge: { level: 'low' },
  findEvidence: { level: 'low' },
  compareSources: { level: 'low' },
  findKnowledgeGaps: { level: 'low' },
  listSources: { level: 'low' },
  getSource: { level: 'low' },
  searchSourcePassages: { level: 'low' },
  ingestUrl: { level: 'low' },
  ingestUrlsBatch: { level: 'low', escalate: bulkEscalation('low') },
  createSource: { level: 'low' },
  createAnnotation: { level: 'low' },
  listAnnotations: { level: 'low' },
  createCollection: { level: 'low' },
  addSourceToCollections: { level: 'low' },
  addSourcesToCollection: { level: 'low' },
  createResearchBrief: { level: 'low' },
  generateResearchBrief: { level: 'low' },
  previewExternalResearch: { level: 'low' },
  previewExternalSource: { level: 'low' },
  startResearchJob: { level: 'low' },
  getResearchJob: { level: 'low' },
  listResearchCandidates: { level: 'low' },
  listCollections: { level: 'low' },
  getCollection: { level: 'low' },
  listCategories: { level: 'low' },
  findSimilarCategories: { level: 'low' },
  listTags: { level: 'low' },
  createTag: { level: 'low' },
  searchClaims: { level: 'low' },
  getClaim: { level: 'low' },
  createClaim: { level: 'low' },
  addClaimEvidence: { level: 'low' },
  analyzeClaimConflicts: { level: 'low' },
  getProcessingJob: { level: 'low' },
  listProcessingJobs: { level: 'low' },
  retryProcessingJob: { level: 'low' },
  listAuditEvents: { level: 'low' },
  getResourceActivity: { level: 'low' },
  getMyActionHistory: { level: 'low' },
  getCurrentUser: { level: 'low' },
  listResearchBriefs: { level: 'low' },
  getResearchBrief: { level: 'low' },
  getGeneratedContent: { level: 'low' },
  generateEvidenceBasedContent: { level: 'low' },
  validateContentCitations: { level: 'low' },
  synthesizeCollection: { level: 'low' },
  compareSourceVersions: { level: 'low' },
  requestActionConfirmation: { level: 'low' },
  confirmAction: { level: 'low' },

  // ---- medium: needs clear intent, executes in the same turn ----------
  updateSource: { level: 'medium', escalate: bulkEscalation('medium') },
  updateSourceTaxonomy: { level: 'medium' },
  removeSourceFromCollections: { level: 'medium' },
  removeSourcesFromCollection: { level: 'medium', escalate: bulkEscalation('medium') },
  reorderCollectionSources: { level: 'medium' },
  assignSourceReviewer: { level: 'medium' },
  reprocessSource: { level: 'medium' },
  createCategory: { level: 'medium' },
  updateCategory: { level: 'medium' },
  moveCategory: { level: 'medium' },
  updateCollection: { level: 'medium' },
  updateAnnotation: { level: 'medium' },
  resolveAnnotation: { level: 'medium' },
  updateResearchBrief: { level: 'medium' },
  submitBriefForReview: { level: 'medium' },
  approveResearchBrief: { level: 'medium' },
  updateGeneratedContent: { level: 'medium' },
  regenerateContentSection: { level: 'medium' },
  restoreSource: { level: 'medium' },
  selectResearchCandidates: { level: 'medium', escalate: bulkEscalation('medium') },

  // A review-status change is medium for one record and high in bulk.
  changeSourceReviewStatus: { level: 'medium', escalate: bulkEscalation('medium') },

  // Editing a claim escalates once the claim is approved or safety-relevant:
  // the risk is not the row count but the clinical weight of the change.
  updateClaim: {
    level: 'medium',
    phrase: 'CONFIRM CLAIM CHANGE',
    escalate: (ctx) => (ctx.targetApproved || ctx.safetyRelevant ? 'high' : 'medium'),
    notes: 'Changing an approved or safety-relevant claim requires confirmation.',
  },
  reviewClaim: { level: 'medium' },

  // ---- high: explicit server-issued confirmation token ----------------
  archiveSource: { level: 'high', phrase: 'CONFIRM ARCHIVE' },
  archiveCollection: { level: 'high', phrase: 'CONFIRM ARCHIVE COLLECTION' },
  archiveClaim: { level: 'high', phrase: 'CONFIRM ARCHIVE CLAIM' },
  archiveAnnotation: { level: 'medium' },
  mergeCategories: { level: 'high', phrase: 'CONFIRM MERGE' },
  mergeTags: {
    level: 'medium',
    phrase: 'CONFIRM MERGE',
    escalate: bulkEscalation('medium'),
  },
  mergeSources: { level: 'high', phrase: 'CONFIRM MERGE SOURCES' },
  bulkChangeSourceReviewStatus: { level: 'high', phrase: 'CONFIRM BULK REVIEW CHANGE' },
  bulkArchiveSources: { level: 'high', phrase: 'CONFIRM BULK ARCHIVE' },
  bulkReviewClaims: { level: 'high', phrase: 'CONFIRM BULK CLAIM REVIEW' },
  removeClaimEvidence: {
    level: 'medium',
    phrase: 'CONFIRM EVIDENCE REMOVAL',
    escalate: (ctx) => (ctx.targetApproved ? 'high' : 'medium'),
    notes: 'Removing evidence from an approved claim requires confirmation.',
  },
  cancelResearchJob: {
    level: 'medium',
    phrase: 'CONFIRM CANCEL',
    escalate: (ctx) => ((ctx.affectedCount ?? 0) > 0 ? 'high' : 'medium'),
    notes: 'Cancelling a job that has already produced results requires confirmation.',
  },
  archiveCategory: {
    level: 'medium',
    phrase: 'CONFIRM ARCHIVE CATEGORY',
    escalate: (ctx) =>
      (ctx.usageCount ?? 0) > getEnv().CATEGORY_ARCHIVE_CONFIRM_THRESHOLD ? 'high' : 'medium',
    notes: 'Archiving a widely used category requires confirmation.',
  },

  // ---- critical: administrators only, always confirmed ----------------
  permanentlyDeleteSource: { level: 'critical', phrase: 'PERMANENTLY DELETE' },
  rotateApiClientCredential: { level: 'critical', phrase: 'CONFIRM ROTATION' },
  revokeApiClient: { level: 'critical', phrase: 'CONFIRM REVOCATION' },
  changeUserRoles: { level: 'critical', phrase: 'CONFIRM ROLE CHANGE' },
  updateRetentionPolicy: { level: 'critical', phrase: 'CONFIRM RETENTION CHANGE' },
};

const CONFIRMABLE: RiskLevel[] = ['high', 'critical'];

/** Effective risk for a call, after batch and clinical escalation. */
export function effectiveRisk(operationId: string, ctx: RiskContext = {}): RiskLevel {
  const rule = RISK_MATRIX[operationId];
  if (!rule) return 'medium'; // unknown operations are never treated as safe
  return rule.escalate ? rule.escalate(ctx) : rule.level;
}

export function requiresConfirmation(operationId: string, ctx: RiskContext = {}): boolean {
  return CONFIRMABLE.includes(effectiveRisk(operationId, ctx));
}

export function confirmationPhrase(operationId: string): string {
  return RISK_MATRIX[operationId]?.phrase ?? 'CONFIRM';
}
