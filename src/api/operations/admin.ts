import { z } from 'zod';
import { defineOperation } from '../registry';
import { ConfirmationInput } from '../handler';
import { requirePermission } from '../../lib/context';
import { withOrg } from '../../lib/db';
import { createApiClient, revokeApiClient } from '../../services/auth';
import { guardConfirmation } from '../../services/confirmation';
import { recordAudit } from '../../services/audit';
import { notFound } from '../../lib/errors';
import { isScope } from '../../domain/permissions';

export const listIntegrationsOperation = defineOperation({
  operationId: 'listIntegrations',
  method: 'GET',
  path: '/admin/integrations',
  summary: 'List configured integrations and API clients (administrators)',
  description:
    'Returns integrations, API clients and OAuth clients with status, scopes and last-used time, without exposing credentials. Requires integration.manage.',
  tags: ['admin'],
  permission: 'integration.manage',
  scopes: [],
  riskLevel: 'low',
  internalOnly: true,
  input: z.object({}),
  handler: async (_input, { ctx }) => {
    requirePermission(ctx, 'integration.manage');
    return withOrg(ctx.organizationId, async (sql) => {
      const apiClients = await sql.query(
        `SELECT id, name, client_type::text, credential_prefix, scopes, status,
                last_used_at, created_at, expires_at, revoked_at
         FROM api_clients ORDER BY created_at DESC`,
      );
      const oauthClients = await sql.query(
        `SELECT id, client_id, name, allowed_scopes, status, created_at
         FROM oauth_clients ORDER BY created_at DESC`,
      );
      const integrations = await sql.query(
        `SELECT id, integration_type, name, status, configuration, last_used_at, created_at
         FROM integrations ORDER BY created_at DESC`,
      );
      return { api_clients: apiClients, oauth_clients: oauthClients, integrations };
    });
  },
});

export const createApiClientOperation = defineOperation({
  operationId: 'createApiClient',
  method: 'POST',
  path: '/admin/api-clients',
  summary: 'Create an API credential for the Custom GPT or another integration (administrators)',
  description: `Creates a scoped API credential that acts as a specific, already-existing user. The plaintext key is returned exactly once and never stored or shown again.

Never grant every scope automatically -- grant only what the integration needs. Requires integration.manage. This is a critical-risk action restricted to administrators.`,
  tags: ['admin'],
  permission: 'integration.manage',
  scopes: [],
  riskLevel: 'critical',
  internalOnly: true,
  input: z.object({
    name: z.string().min(1),
    client_type: z.enum(['custom_gpt', 'browser_extension', 'internal_app', 'automation', 'external_partner']),
    scopes: z.array(z.string()),
    acts_as_user_id: z.string().uuid(),
    expires_at: z.string().nullish(),
  }),
  handler: async (input, { ctx }) => {
    const scopes = input.scopes.filter(isScope);
    const result = await createApiClient(ctx, {
      name: input.name,
      clientType: input.client_type,
      scopes,
      actsAsUserId: input.acts_as_user_id,
      expiresAt: input.expires_at,
    });
    return {
      id: result.id,
      api_key: result.plaintextKey,
      key_prefix: result.prefix,
      warning: 'This key is shown once. Store it securely; it cannot be retrieved again.',
    };
  },
});

export const revokeApiClientOperation = defineOperation({
  operationId: 'revokeApiClient',
  method: 'POST',
  path: '/admin/api-clients/{clientId}/revoke',
  summary: 'Revoke an API credential (administrators)',
  description:
    'Immediately revokes an API credential; any further use fails authentication. Requires integration.manage and a server-issued confirmation. This is a critical-risk, irreversible action -- a new credential must be issued afterward if the integration is still needed.',
  tags: ['admin'],
  permission: 'integration.manage',
  scopes: [],
  riskLevel: 'critical',
  mayRequireConfirmation: true,
  internalOnly: true,
  input: ConfirmationInput.extend({ clientId: z.string().uuid() }),
  handler: async (input, { ctx }) => {
    requirePermission(ctx, 'integration.manage');
    await withOrg(ctx.organizationId, async (sql) => {
      const client = await sql.one<{ id: string; name: string }>(
        `SELECT id, name FROM api_clients WHERE id = $1`,
        [input.clientId],
      );
      if (!client) throw notFound('api client', input.clientId);

      await guardConfirmation(sql, ctx, {
        actionType: 'revokeApiClient',
        resourceType: 'api_client',
        resourceIds: [input.clientId],
        actionPayload: {},
        humanSummary: `Revoke the API credential "${client.name}". Any integration using it will immediately stop working.`,
        confirmationId: input.confirmation_id,
      });
    });

    await revokeApiClient(ctx, input.clientId);
    return { id: input.clientId, status: 'revoked' };
  },
});
