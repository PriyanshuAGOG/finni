import { z } from 'zod';
import { defineOperation } from '../registry';
import { getResourceActivity, listAuditEvents, listMyActions } from '../../services/audit';
import { queueHealth } from '../../services/processing';

export const listAuditEventsOperation = defineOperation({
  operationId: 'listAuditEvents',
  method: 'GET',
  path: '/audit',
  summary: 'List organization audit events',
  description:
    'Returns audit log entries filtered by actor, action, resource, interface or date range. Requires audit.read. This operation does not modify anything.',
  tags: ['audit'],
  permission: 'audit.read',
  scopes: ['audit.read'],
  riskLevel: 'low',
  input: z.object({
    actor_id: z.string().uuid().optional(),
    actor_type: z.string().optional(),
    action: z.string().optional(),
    resource_type: z.string().optional(),
    resource_id: z.string().uuid().optional(),
    source_interface: z.string().optional(),
    status: z.string().optional(),
    created_after: z.string().optional(),
    created_before: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, { ctx }) => {
    const result = await listAuditEvents(ctx, {
      actorId: input.actor_id,
      actorType: input.actor_type,
      action: input.action,
      resourceType: input.resource_type,
      resourceId: input.resource_id,
      sourceInterface: input.source_interface,
      status: input.status,
      createdAfter: input.created_after,
      createdBefore: input.created_before,
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      items: result.items,
      pagination: { next_cursor: result.nextCursor, has_more: Boolean(result.nextCursor), limit: input.limit ?? 25 },
    };
  },
});

export const getResourceActivityOperation = defineOperation({
  operationId: 'getResourceActivity',
  method: 'GET',
  path: '/audit/resource/{resourceType}/{resourceId}',
  summary: 'Get the audit history for one specific record',
  description: 'Returns the audit trail for one resource. Requires audit.read. This operation does not modify anything.',
  tags: ['audit'],
  permission: 'audit.read',
  scopes: ['audit.read'],
  riskLevel: 'low',
  input: z.object({
    resourceType: z.string(),
    resourceId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: (input, { ctx }) =>
    getResourceActivity(ctx, input.resourceType, input.resourceId, input.limit),
});

export const getMyActionHistoryOperation = defineOperation({
  operationId: 'getMyActionHistory',
  method: 'GET',
  path: '/audit/my-actions',
  summary: 'See what has been done on the current user\'s behalf, including by this GPT',
  description: `Returns the current user's own audit history, including everything performed on their behalf by the Custom GPT, the dashboard assistant or the API. Available to any authenticated user without requiring audit.read.

Use this when the user asks what you changed, or wants to review recent actions taken on their behalf. This operation does not modify anything.`,
  gptDescription:
    "Returns the current user's own audit history, including everything done on their behalf by this GPT, the dashboard, or the API. Use when asked what changed. Does not modify anything.",
  tags: ['audit'],
  scopes: [],
  riskLevel: 'low',
  input: z.object({
    action: z.string().optional(),
    resource_type: z.string().optional(),
    source_interface: z.string().optional(),
    created_after: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, { ctx }) => {
    const result = await listMyActions(ctx, {
      action: input.action,
      resourceType: input.resource_type,
      sourceInterface: input.source_interface,
      createdAfter: input.created_after,
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      items: result.items,
      pagination: { next_cursor: result.nextCursor, has_more: Boolean(result.nextCursor), limit: input.limit ?? 25 },
    };
  },
});

export const getQueueHealthOperation = defineOperation({
  operationId: 'getQueueHealth',
  method: 'GET',
  path: '/admin/queue-health',
  summary: 'Get processing queue health and recent AI cost (administrators)',
  description:
    'Returns job counts by status, the oldest queued job, recent failures and AI cost over the last 30 days. Requires audit.read. Intended for the administrator operations page; excluded from the default GPT action set.',
  tags: ['admin'],
  permission: 'audit.read',
  scopes: [],
  riskLevel: 'low',
  internalOnly: true,
  input: z.object({}),
  handler: (_input, { ctx }) => queueHealth(ctx),
});
