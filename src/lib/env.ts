import { z } from 'zod';

/**
 * `.env.example` ships several optional keys blank (`KEY=`), and the docs
 * tell you to copy it straight to `.env`. That means "unset" arrives as
 * `""`, not `undefined` -- which `.optional()` alone does not absorb, so a
 * field with an extra constraint (`.url()`, `.min()`) would fail
 * validation on a value the file explicitly ships as empty. Blank first.
 */
const emptyToUndefined = z.literal('').transform(() => undefined);

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

  APP_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('http://localhost:3000'),
  ),
  SESSION_COOKIE_NAME: z.string().default('nbros_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

  /** 32-byte key, hex or base64, used to encrypt integration credentials. */
  ENCRYPTION_KEY: z.union([emptyToUndefined, z.string().min(32)]).optional(),

  /**
   * AI provider selection. `deterministic` is a real, self-contained
   * provider (no network, no keys) used for local development, CI and
   * tests. It produces schema-valid structured output and stable
   * embeddings so the whole pipeline runs end to end offline.
   */
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'deterministic']).default('deterministic'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.union([emptyToUndefined, z.string().url()]).optional(),

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
  AI_EMBEDDING_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://api.openai.com/v1'),
  ),

  /** External discovery provider for research jobs. */
  SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily']).default('none'),
  SEARCH_API_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3', 'appwrite']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * Appwrite is used only for file storage (source snapshots) -- the
   * relational data, RLS-based tenancy and job queue all stay on
   * Postgres, which Appwrite's document database cannot support natively.
   */
  APPWRITE_ENDPOINT: z.union([emptyToUndefined, z.string().url()]).optional(),
  APPWRITE_PROJECT_ID: z.string().optional(),
  /** Server-side secret. Never expose to the client; never prefix NEXT_PUBLIC_. */
  APPWRITE_API_KEY: z.string().optional(),
  APPWRITE_BUCKET_ID: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().default('research_os_sources'),
  ),

  /**
   * "console" (default) logs the email instead of sending it -- fine for
   * local dev, useless in production. "resend" sends via the Resend API.
   */
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  EMAIL_FROM: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().default('Nirog Bhoomi Research OS <onboarding@resend.dev>'),
  ),
  /** Server-side secret. Required when EMAIL_PROVIDER=resend. */
  RESEND_API_KEY: z.string().optional(),
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(168),

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
}).refine(
  (env) =>
    env.STORAGE_DRIVER !== 'appwrite' ||
    (env.APPWRITE_ENDPOINT && env.APPWRITE_PROJECT_ID && env.APPWRITE_API_KEY),
  {
    message:
      'APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY are all required when STORAGE_DRIVER=appwrite.',
    path: ['STORAGE_DRIVER'],
  },
).refine((env) => env.EMAIL_PROVIDER !== 'resend' || env.RESEND_API_KEY, {
  message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend.',
  path: ['EMAIL_PROVIDER'],
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
