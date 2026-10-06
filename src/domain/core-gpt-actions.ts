/**
 * ChatGPT's Custom GPT Actions editor capped a single GPT at 30 operations
 * -- far fewer than the full registry. This is the curated subset exposed
 * to both openapi/gpt-actions.yaml (legacy Actions, kept for as long as
 * OpenAI still runs Custom GPTs) and the MCP server (src/mcp), so the two
 * integration surfaces never drift into offering different tools for the
 * same assistant: every operationId referenced by name in
 * docs/gpt-instructions.md (so the instructions never point at a tool
 * that isn't actually available), plus every core article/knowledge-base
 * management action -- add (URL/DOI/pasted text), fetch/query/reference
 * (search, get, list, exact passages), browse the fixed category
 * taxonomy, file into a collection and edit metadata. Knowledge
 * categorization is automatic and source review is not part of the
 * active workflow. Claim creation (createClaim/addClaimEvidence) did not
 * make the cut; reviewClaim/analyzeClaimConflicts still work on claims
 * created via the dashboard. Admin operations (team, integrations, audit
 * browsing) stay internalOnly regardless. Swap entries here (and re-run
 * npm run openapi:generate) to change the set -- see docs/gpt-setup-guide.md.
 */
export const CORE_GPT_ACTIONS = new Set([
  'getCurrentUser',
  'searchKnowledge',
  'synthesizeKnowledge',
  'findEvidence',
  'compareSources',
  'searchSourcePassages',
  'getSource',
  'listSources',
  'ingestUrl',
  'ingestIdentifier',
  'createSource',
  'listCategories',
  'listCollections',
  'createCollection',
  'addSourceToCollections',
  'updateSource',
  'reviewClaim',
  'analyzeClaimConflicts',
  'generateResearchBrief',
  'generateEvidenceBasedContent',
  'validateContentCitations',
  'previewExternalResearch',
  'startResearchJob',
  'selectResearchCandidates',
  'requestActionConfirmation',
  'confirmAction',
  'getMyActionHistory',
]);
