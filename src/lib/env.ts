import { z } from 'zod';

/**
 * Environment validation. Fails fast at boot rather than at the first
 * request that happens to need a missing variable.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * The application connects as a role WITHOUT superuser or table
   * ownership, so the row-level security policies actually apply to it.
   * A superuser bypasses RLS silently, which would disable organization
   * isolation without any visible error.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Owner connection used only by the migration runner. */
  MIGRATION_DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  SESSION_COOKIE_NAME: z.string().default('nbros_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

  /** 32-byte key, hex or base64, used to encrypt integration credentials. */
  ENCRYPTION_KEY: z.string().min(32).optional(),

  /**
   * AI provider selection. `deterministic` is a real, self-contained
   * provider (no network, no keys) used for local development, CI and
   * tests. It produces schema-valid structured output and stable
   * embeddings so the whole pipeline runs end to end offline.
   */
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'deterministic']).default('deterministic'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),

  // Model names are configuration, never hard-coded at call sites.
  AI_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  AI_MODEL_EXTRACTION: z.string().default('claude-sonnet-5'),
  AI_MODEL_SYNTHESIS: z.string().default('claude-opus-5'),
  AI_MODEL_EMBEDDING: z.string().default('text-embedding-3-small'),

  /**
   * Embeddings are selected separately from completions: Anthropic does
   * not serve an embedding endpoint, so an Anthropic deployment pairs its
   * completions with an embedding provider of its own choosing.
   */
  AI_EMBEDDING_PROVIDER: z.enum(['openai', 'deterministic']).default('deterministic'),
  AI_EMBEDDING_API_KEY: z.string().optional(),
  AI_EMBEDDING_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  /** External discovery provider for research jobs. */
  SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily']).default('none'),
  SEARCH_API_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),

  RATE_LIMIT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  MAX_INGEST_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  MAX_BULK_OPERATION_SIZE: z.coerce.number().int().positive().default(200),
  MAX_SYNTHESIS_SOURCES: z.coerce.number().int().positive().default(30),
  MAX_SOURCE_TEXT_BYTES: z.coerce.number().int().positive().default(120_000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),

  /** Archiving a category used by more sources than this needs confirming. */
  CATEGORY_ARCHIVE_CONFIRM_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
  /** Bulk operations larger than this need a confirmation token. */
  BULK_CONFIRM_THRESHOLD: z.coerce.number().int().positive().default(10),
  CONFIRMATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so a changed process.env is re-read. */
export function resetEnvCache(): void {
  cached = null;
}
