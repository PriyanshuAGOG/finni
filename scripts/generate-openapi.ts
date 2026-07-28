/**
 * Generates the OpenAPI 3.1 specification directly from the operation
 * registry in src/api/operations, so the schema and the running API can
 * never drift apart -- there is no second, hand-maintained copy of the
 * contract.
 *
 * Produces two files:
 *   openapi/full.yaml        -- every registered operation.
 *   openapi/gpt-actions.yaml -- the subset safe to expose to the Custom
 *                                GPT (excludes internalOnly operations,
 *                                raw credential handling, etc).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { reportError } from './lib/report-error';
import { zodToJsonSchema } from 'zod-to-json-schema';
import YAML from 'yaml';
import { registerOperations } from '../src/api/operations';
import { allOperations, type Operation } from '../src/api/registry';
import { ERROR_CODES } from '../src/lib/errors';

registerOperations();

const OUT_DIR = join(process.cwd(), 'openapi');

/**
 * ChatGPT's Custom GPT Actions editor caps a single GPT at 30 operations
 * -- far fewer than the full registry. This is the curated subset that
 * ships in openapi/gpt-actions.yaml: every operationId referenced by
 * name in docs/gpt-instructions.md (so the GPT's own instructions never
 * point at a tool it doesn't have), plus the minimum extra read/write
 * operations needed for search, save, taxonomy, collections, claims,
 * review and briefs to actually function end to end. Admin operations
 * (team, integrations, audit browsing) stay internalOnly regardless --
 * a full research/knowledge workflow was the priority for the 30 slots,
 * not exhaustiveness. Split into a second GPT (e.g. a review/admin
 * assistant) if more coverage is needed; see docs/gpt-setup-guide.md.
 */
const CORE_GPT_ACTIONS = new Set([
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
  'findSimilarCategories',
  'createCategory',
  'listCollections',
  'createCollection',
  'addSourceToCollections',
  'createClaim',
  'addClaimEvidence',
  'reviewClaim',
  'analyzeClaimConflicts',
  'changeSourceReviewStatus',
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

const SERVERS = [
  { url: 'https://research.nirogbhoomi.com/api/v1', description: 'Production' },
  { url: 'http://localhost:3000/api/v1', description: 'Local development' },
];

// ---------------------------------------------------------------------
// Zod -> OpenAPI schema conversion
// ---------------------------------------------------------------------

/** Unwraps effects/optional/nullable/default wrappers to the base type. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  if (schema instanceof z.ZodEffects) return unwrap(schema._def.schema);
  if (schema instanceof z.ZodOptional) return unwrap(schema._def.innerType);
  if (schema instanceof z.ZodNullable) return unwrap(schema._def.innerType);
  if (schema instanceof z.ZodDefault) return unwrap(schema._def.innerType);
  void def;
  return schema;
}

/** Finds the underlying ZodObject shape, following .refine() and similar wrappers. */
function objectShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
  const base = unwrap(schema);
  if (base instanceof z.ZodObject) return base.shape;
  return null;
}

function isOptionalField(fieldSchema: z.ZodTypeAny): boolean {
  return (
    fieldSchema instanceof z.ZodOptional ||
    fieldSchema instanceof z.ZodNullable ||
    fieldSchema instanceof z.ZodDefault ||
    (fieldSchema instanceof z.ZodEffects && isOptionalField(fieldSchema._def.schema))
  );
}

function toJsonSchema(fieldSchema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(fieldSchema, { target: 'openApi3', $refStrategy: 'none' });
  // zod-to-json-schema includes a top-level $schema key that OpenAPI does
  // not recognise; strip it and any other JSON-Schema-only metadata.
  const { $schema, ...rest } = converted as Record<string, unknown>;
  void $schema;
  return rest;
}

// ---------------------------------------------------------------------
// Operation -> OpenAPI operation object
// ---------------------------------------------------------------------

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function buildOperationObject(operation: Operation): Record<string, unknown> {
  const shape = objectShape(operation.input);
  const pathParams = new Set(pathParamNames(operation.path));

  const parameters: Record<string, unknown>[] = [];
  const bodyProperties: Record<string, unknown> = {};
  const bodyRequired: string[] = [];

  if (shape) {
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const jsonSchema = toJsonSchema(fieldSchema);
      const optional = isOptionalField(fieldSchema);
      const description = (fieldSchema as unknown as { description?: string }).description;
      if (description) jsonSchema.description = description;

      if (pathParams.has(key)) {
        parameters.push({
          name: key,
          in: 'path',
          required: true,
          schema: jsonSchema,
        });
      } else if (operation.method === 'GET' || operation.method === 'DELETE') {
        parameters.push({
          name: key,
          in: 'query',
          required: !optional,
          schema: jsonSchema,
        });
      } else {
        bodyProperties[key] = jsonSchema;
        if (!optional) bodyRequired.push(key);
      }
    }
  }

  const hasBody =
    Object.keys(bodyProperties).length > 0 && operation.method !== 'GET';

  const responseSchema = operation.output
    ? toJsonSchema(operation.output)
    : { type: 'object', additionalProperties: true };

  const op: Record<string, unknown> = {
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.description,
    tags: operation.tags,
    'x-risk-level': operation.riskLevel,
    'x-may-require-confirmation': Boolean(operation.mayRequireConfirmation),
    'x-required-scopes': operation.scopes,
  };

  if (parameters.length > 0) op.parameters = parameters;

  if (hasBody) {
    op.requestBody = {
      required: bodyRequired.length > 0,
      content: {
        'application/json': {
          schema: { type: 'object', properties: bodyProperties, required: bodyRequired },
          ...(operation.examples?.request ? { example: operation.examples.request } : {}),
        },
      },
    };
  }

  if (operation.idempotent) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'A client-generated key that makes a retried write safe to repeat.',
      schema: { type: 'string' },
    });
    if (parameters.length === 1) op.parameters = parameters;
  }

  op.responses = {
    '200': {
      description: 'Success.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: { type: 'object', properties: responseSchema.properties ?? {}, additionalProperties: true },
              meta: { $ref: '#/components/schemas/ResponseMeta' },
            },
          },
          ...(operation.examples?.response
            ? { example: { data: operation.examples.response, meta: { request_id: 'req_example' } } }
            : {}),
        },
      },
    },
    default: {
      description: 'Error.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      },
    },
  };

  return op;
}

function buildPaths(operations: Operation[]): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const key = operation.path.replace(/\{(\w+)\}/g, '{$1}');
    paths[key] = paths[key] ?? {};
    paths[key][operation.method.toLowerCase()] = buildOperationObject(operation);
  }
  return paths;
}

// ---------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------

function buildComponents(): Record<string, unknown> {
  return {
    securitySchemes: {
      OAuth2: {
        type: 'oauth2',
        description: 'User-specific access via the authorization code flow (with PKCE).',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://research.nirogbhoomi.com/oauth/authorize',
            tokenUrl: 'https://research.nirogbhoomi.com/oauth/token',
            scopes: Object.fromEntries(
              [
                'profile.read', 'knowledge.read', 'source.read', 'source.write', 'source.review',
                'collection.read', 'collection.write', 'taxonomy.read', 'taxonomy.write',
                'claim.read', 'claim.write', 'claim.review', 'annotation.read', 'annotation.write',
                'research.run', 'brief.read', 'brief.write', 'content.generate', 'audit.read',
                'admin.integrations',
              ].map((s) => [s, s.replace(/[._]/g, ' ')]),
            ),
          },
        },
      },
      ApiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Prototype credential (prefix nbgpt_) that acts as a constrained, pre-authorized user. Use OAuth2 for production deployments.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'request_id', 'retryable'],
            properties: {
              code: { type: 'string', enum: Object.keys(ERROR_CODES) },
              message: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
              request_id: { type: 'string' },
              retryable: { type: 'boolean' },
              suggested_action: { type: 'string' },
            },
          },
        },
      },
      ResponseMeta: {
        type: 'object',
        properties: {
          request_id: { type: 'string' },
          operation: { type: 'string' },
          duration_ms: { type: 'number' },
          source: {
            type: 'string',
            enum: ['internal_approved', 'internal_unreviewed', 'internal_archived', 'external_web', 'mixed'],
            description: 'Where the returned information originated.',
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          next_cursor: { type: ['string', 'null'] },
          has_more: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------

function buildDocument(operations: Operation[], gptFacing: boolean): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: gptFacing
        ? 'Nirog Bhoomi Research OS -- Custom GPT Actions'
        : 'Nirog Bhoomi Research OS API',
      version: '1.0.0',
      description: gptFacing
        ? 'The subset of the Nirog Bhoomi Research OS API exposed to the Nirog Bhoomi Research Assistant Custom GPT. Every write is permission-checked, scope-checked and audit-logged identically to the dashboard.'
        : 'Complete versioned API for the Nirog Bhoomi Research OS: the dashboard, the internal AI assistant, the Custom GPT, and any future integration all call these same operations.',
    },
    servers: SERVERS,
    security: [{ OAuth2: [] }, { ApiKey: [] }],
    tags: [...new Set(operations.flatMap((o) => o.tags))].sort().map((tag) => ({ name: tag })),
    paths: buildPaths(operations),
    components: buildComponents(),
  };
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

function validate(operations: Operation[]): string[] {
  const problems: string[] = [];

  const ids = new Set<string>();
  for (const op of operations) {
    if (ids.has(op.operationId)) problems.push(`Duplicate operationId: ${op.operationId}`);
    ids.add(op.operationId);

    for (const param of pathParamNames(op.path)) {
      const shape = objectShape(op.input);
      if (!shape || !(param in shape)) {
        problems.push(`${op.operationId}: path parameter "${param}" is not in the input schema.`);
      }
    }

    if (!op.description || op.description.length < 40) {
      problems.push(`${op.operationId}: description is too short for a GPT to use reliably.`);
    }
    if (op.mayRequireConfirmation && !/confirm/i.test(op.description)) {
      problems.push(`${op.operationId}: mayRequireConfirmation is set but the description doesn't mention confirmation.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------

async function main() {
  const operations = allOperations();
  const problems = validate(operations);
  if (problems.length > 0) {
    console.error(`OpenAPI validation failed with ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const full = buildDocument(operations, false);
  const gptOperations = operations.filter((o) => !o.internalOnly && CORE_GPT_ACTIONS.has(o.operationId));
  const gptFacing = buildDocument(gptOperations, true);

  const missingCoreActions = [...CORE_GPT_ACTIONS].filter(
    (id) => !operations.some((o) => o.operationId === id),
  );
  if (missingCoreActions.length > 0) {
    console.error(`CORE_GPT_ACTIONS references unknown operationId(s): ${missingCoreActions.join(', ')}`);
    process.exit(1);
  }
  if (gptOperations.length > 30) {
    console.error(`gpt-actions.yaml has ${gptOperations.length} operations; ChatGPT caps a single GPT at 30.`);
    process.exit(1);
  }

  await writeFile(join(OUT_DIR, 'full.yaml'), YAML.stringify(full, { lineWidth: 100 }), 'utf8');
  await writeFile(
    join(OUT_DIR, 'gpt-actions.yaml'),
    YAML.stringify(gptFacing, { lineWidth: 100 }),
    'utf8',
  );

  console.log(`Wrote openapi/full.yaml (${operations.length} operations).`);
  console.log(`Wrote openapi/gpt-actions.yaml (${gptOperations.length} operations -- curated to stay within ChatGPT's 30-action cap).`);
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
