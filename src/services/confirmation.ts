import { withOrg, type Sql } from '../lib/db';
import type { ActorContext } from '../lib/context';
import { ApiError, notFound } from '../lib/errors';
import { hashPayload } from '../lib/crypto';
import { getEnv } from '../lib/env';
import {
  confirmationPhrase,
  effectiveRisk,
  requiresConfirmation,
  type RiskContext,
  type RiskLevel,
} from '../domain/risk';
import { recordAudit } from './audit';

export interface ConfirmationRecord {
  id: string;
  action_type: string;
  resource_type: string;
  resource_ids: string[];
  summary: string;
  required_phrase: string;
  risk_level: RiskLevel;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface RequestConfirmationInput {
  actionType: string;
  resourceType: string;
  resourceIds: string[];
  actionPayload: Record<string, unknown>;
  humanSummary: string;
  riskContext?: RiskContext;
}

/**
 * Issues a server-side confirmation record.
 *
 * The point of this indirection is that a conversational "yes" is not
 * evidence of anything the backend can verify. The confirmation binds the
 * user, the action, the exact resource set and a hash of the payload, so
 * an action confirmed for one set of records cannot be replayed against
 * another.
 */
export async function requestConfirmation(
  ctx: ActorContext,
  input: RequestConfirmationInput,
): Promise<ConfirmationRecord> {
  const env = getEnv();
  const risk = effectiveRisk(input.actionType, {
    affectedCount: input.resourceIds.length,
    ...input.riskContext,
  });
  const phrase = confirmationPhrase(input.actionType);
  const payloadHash = hashPayload({
    action: input.actionType,
    resources: [...input.resourceIds].sort(),
    payload: input.actionPayload,
  });
  const expiresAt = new Date(Date.now() + env.CONFIRMATION_TTL_MINUTES * 60_000);

  return withOrg(ctx.organizationId, async (sql) => {
    const row = await sql.one<ConfirmationRecord>(
      `INSERT INTO action_confirmations (
         organization_id, user_id, api_client_id, action_type, resource_type,
         resource_ids, action_payload_hash, summary, required_phrase,
         risk_level, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::risk_level,$11)
       RETURNING id, action_type, resource_type, resource_ids, summary,
                 required_phrase, risk_level, status, expires_at, created_at`,
      [
        ctx.organizationId,
        ctx.userId,
        ctx.apiClientId ?? null,
        input.actionType,
        input.resourceType,
        JSON.stringify(input.resourceIds),
        payloadHash,
        input.humanSummary,
        phrase,
        risk,
        expiresAt.toISOString(),
      ],
    );

    await recordAudit(sql, ctx, {
      action: 'confirmation.requested',
      resourceType: 'action_confirmation',
      resourceId: row!.id,
      newState: {
        action_type: input.actionType,
        risk_level: risk,
        resource_ids: input.resourceIds,
      },
    });

    return row!;
  });
}

export async function confirmAction(
  ctx: ActorContext,
  confirmationId: string,
  phrase: string,
): Promise<ConfirmationRecord> {
  return withOrg(ctx.organizationId, async (sql) => {
    const record = await sql.one<ConfirmationRecord & { user_id: string }>(
      `SELECT * FROM action_confirmations WHERE id = $1 FOR UPDATE`,
      [confirmationId],
    );
    if (!record) throw notFound('confirmation', confirmationId);

    // The confirming user must be the requesting user. This is what stops
    // one account's confirmation from authorizing another's action.
    if (record.user_id !== ctx.userId) {
      throw new ApiError('FORBIDDEN', 'This confirmation belongs to a different user.', {
        suggestedAction: 'Request a new confirmation for this action.',
      });
    }
    if (record.status === 'used') {
      throw new ApiError('CONFIRMATION_EXPIRED', 'This confirmation has already been used.', {
        suggestedAction: 'Request a new confirmation.',
      });
    }
    if (record.status !== 'pending') {
      throw new ApiError('CONFIRMATION_EXPIRED', `This confirmation is ${record.status}.`, {
        suggestedAction: 'Request a new confirmation.',
      });
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      await sql.query(
        `UPDATE action_confirmations SET status = 'expired' WHERE id = $1`,
        [confirmationId],
      );
      throw new ApiError('CONFIRMATION_EXPIRED', 'This confirmation has expired.', {
        details: { expires_at: record.expires_at },
        suggestedAction: 'Request a new confirmation and confirm it promptly.',
      });
    }
    if (phrase.trim().toUpperCase() !== record.required_phrase.toUpperCase()) {
      throw new ApiError('INVALID_INPUT', 'The confirmation phrase did not match.', {
        details: { required_phrase: record.required_phrase },
        suggestedAction: `Reply with exactly: ${record.required_phrase}`,
      });
    }

    const updated = await sql.one<ConfirmationRecord>(
      `UPDATE action_confirmations
       SET status = 'confirmed', confirmed_at = now()
       WHERE id = $1
       RETURNING id, action_type, resource_type, resource_ids, summary,
                 required_phrase, risk_level, status, expires_at, created_at`,
      [confirmationId],
    );

    await recordAudit(sql, ctx, {
      action: 'confirmation.confirmed',
      resourceType: 'action_confirmation',
      resourceId: confirmationId,
      newState: { status: 'confirmed', action_type: record.action_type },
    });

    return updated!;
  });
}

export interface ConfirmationGuardInput {
  actionType: string;
  resourceType: string;
  resourceIds: string[];
  actionPayload: Record<string, unknown>;
  humanSummary: string;
  confirmationId?: string | null;
  riskContext?: RiskContext;
}

/**
 * Called by every mutating service before it does the work.
 *
 * Returns the confirmation id that authorized the call (or null when the
 * action does not need one) and marks it used, so a single confirmation
 * can never authorize two calls.
 */
export async function guardConfirmation(
  sql: Sql,
  ctx: ActorContext,
  input: ConfirmationGuardInput,
): Promise<string | null> {
  const riskCtx: RiskContext = {
    affectedCount: input.resourceIds.length,
    ...input.riskContext,
  };

  if (!requiresConfirmation(input.actionType, riskCtx)) return null;

  const risk = effectiveRisk(input.actionType, riskCtx);

  if (!input.confirmationId) {
    throw new ApiError('CONFIRMATION_REQUIRED', 'This operation requires explicit confirmation.', {
      details: {
        risk_level: risk,
        action_summary: input.humanSummary,
        action_type: input.actionType,
        affected_count: input.resourceIds.length,
        required_phrase: confirmationPhrase(input.actionType),
        confirmation_endpoint: '/confirmations',
      },
      suggestedAction:
        'Call requestActionConfirmation, present the summary to the user, obtain explicit confirmation, call confirmAction, then retry with the confirmation_id.',
    });
  }

  const record = await sql.one<{
    id: string;
    user_id: string;
    action_type: string;
    resource_ids: string[];
    action_payload_hash: string;
    status: string;
    expires_at: string;
  }>(`SELECT * FROM action_confirmations WHERE id = $1 FOR UPDATE`, [input.confirmationId]);

  if (!record) throw notFound('confirmation', input.confirmationId);

  const reject = (message: string, extra: Record<string, unknown> = {}) => {
    throw new ApiError('CONFIRMATION_EXPIRED', message, {
      details: { confirmation_id: input.confirmationId, ...extra },
      suggestedAction: 'Request a fresh confirmation for this exact action and retry.',
    });
  };

  if (record.user_id !== ctx.userId) reject('This confirmation belongs to a different user.');
  if (record.status === 'used') reject('This confirmation has already been used.');
  if (record.status !== 'confirmed') reject(`This confirmation is ${record.status}, not confirmed.`);
  if (new Date(record.expires_at).getTime() < Date.now()) reject('This confirmation has expired.');
  if (record.action_type !== input.actionType) {
    reject('This confirmation was issued for a different action.', {
      confirmed_action: record.action_type,
      attempted_action: input.actionType,
    });
  }

  const expectedIds = [...input.resourceIds].sort();
  const confirmedIds = [...(record.resource_ids ?? [])].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(confirmedIds)) {
    reject('This confirmation was issued for a different set of records.');
  }

  const payloadHash = hashPayload({
    action: input.actionType,
    resources: expectedIds,
    payload: input.actionPayload,
  });
  if (payloadHash !== record.action_payload_hash) {
    reject('The request payload changed after this confirmation was issued.');
  }

  await sql.query(
    `UPDATE action_confirmations SET status = 'used', used_at = now() WHERE id = $1`,
    [input.confirmationId],
  );

  return input.confirmationId;
}

export async function getConfirmation(
  ctx: ActorContext,
  id: string,
): Promise<ConfirmationRecord> {
  const row = await withOrg(ctx.organizationId, (sql) =>
    sql.one<ConfirmationRecord>(
      `SELECT id, action_type, resource_type, resource_ids, summary,
              required_phrase, risk_level, status, expires_at, created_at
       FROM action_confirmations WHERE id = $1 AND user_id = $2`,
      [id, ctx.userId],
    ),
  );
  if (!row) throw notFound('confirmation', id);
  return row;
}

/** Marks stale pending confirmations expired. Run periodically. */
export async function expireStaleConfirmations(organizationId: string): Promise<number> {
  return withOrg(organizationId, async (sql) => {
    const rows = await sql.query<{ id: string }>(
      `UPDATE action_confirmations
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now()
       RETURNING id`,
    );
    return rows.length;
  });
}
