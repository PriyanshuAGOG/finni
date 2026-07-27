import { z } from 'zod';
import { defineOperation } from '../registry';
import { confirmAction, getConfirmation, requestConfirmation } from '../../services/confirmation';

export const requestActionConfirmationOperation = defineOperation({
  operationId: 'requestActionConfirmation',
  method: 'POST',
  path: '/confirmations',
  summary: 'Request a server-issued confirmation for a high-risk action',
  description: `Issues a confirmation record for a specific action, resource set and payload, returning a required confirmation phrase and an expiry time.

Call this before any high-risk or critical action -- archiving, bulk operations, merges, or changing an approved clinical claim. Present the exact summary this returns to the user verbatim, obtain their explicit agreement, then call confirmAction, then retry the original operation with the returned confirmation_id.

The confirmation is bound to this exact resource set and payload; it cannot be reused for a different action or a different set of records. This operation writes a confirmation record but does not perform the underlying action.`,
  tags: ['confirmations'],
  scopes: [],
  riskLevel: 'low',
  input: z.object({
    action_type: z.string().min(1),
    resource_type: z.string().min(1),
    resource_ids: z.array(z.string()).min(1),
    action_payload: z.record(z.string(), z.unknown()).optional(),
    human_summary: z.string().min(1),
  }),
  handler: (input, { ctx }) =>
    requestConfirmation(ctx, {
      actionType: input.action_type,
      resourceType: input.resource_type,
      resourceIds: input.resource_ids,
      actionPayload: input.action_payload ?? {},
      humanSummary: input.human_summary,
    }),
});

export const confirmActionOperation = defineOperation({
  operationId: 'confirmAction',
  method: 'POST',
  path: '/confirmations/{confirmationId}/confirm',
  summary: 'Confirm a previously requested high-risk action',
  description: `Marks a confirmation as confirmed after the user has explicitly agreed, by supplying the exact required phrase.

Only call this after the user has been shown the confirmation summary and has clearly agreed. Do not fabricate or guess the phrase -- use exactly what requestActionConfirmation returned. Once confirmed, use the confirmation_id with the original operation; it can only be used once.`,
  tags: ['confirmations'],
  scopes: [],
  riskLevel: 'low',
  input: z.object({
    confirmationId: z.string().uuid(),
    confirmation_phrase: z.string().min(1),
  }),
  handler: (input, { ctx }) => confirmAction(ctx, input.confirmationId, input.confirmation_phrase),
});

export const getConfirmationOperation = defineOperation({
  operationId: 'getConfirmationStatus',
  method: 'GET',
  path: '/confirmations/{confirmationId}',
  summary: 'Check a confirmation\'s current status',
  description: 'Returns a confirmation\'s status: pending, confirmed, used, expired or cancelled. This operation does not modify anything.',
  tags: ['confirmations'],
  scopes: [],
  riskLevel: 'low',
  input: z.object({ confirmationId: z.string().uuid() }),
  handler: (input, { ctx }) => getConfirmation(ctx, input.confirmationId),
});
