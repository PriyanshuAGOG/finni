import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getEnv } from './env';

const RUNTIME_ROLE = 'nirog_app_runtime';

let pool: Pool | null = null;
const configuredClients = new WeakSet<PoolClient>();

/**
 * pg currently treats sslmode=require/prefer/verify-ca as verify-full, but
 * warns that pg v9 will change those semantics. Preserve the current,
 * stricter behavior explicitly so production is warning-free and future
 * upgrades cannot silently weaken certificate verification.
 */
export function normalizePostgresConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    if (sslMode && ['prefer', 'require', 'verify-ca'].includes(sslMode)) {
      url.searchParams.set('sslmode', 'verify-full');
      return url.toString();
    }
  } catch {
    // Let pg report malformed/non-URL connection strings as it did before.
  }
  return connectionString;
}

export function getPool(): Pool {
  if (pool) return pool;
  const env = getEnv();
  pool = new Pool({
    connectionString: normalizePostgresConnectionString(env.DATABASE_URL),
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // A pooled connection died while idle. The pool replaces it; log and
    // carry on rather than taking the process down.
    console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: err.message }));
  });
  return pool;
}

async function getRuntimeClient(): Promise<PoolClient> {
  const client = await getPool().connect();
  if (configuredClients.has(client)) return client;

  try {
    // DATABASE_URL may point at the Neon owner account. Never let normal
    // application/service code inherit that role: it has BYPASSRLS and an
    // unscoped DELETE would otherwise cross tenant boundaries.
    await client.query(`SET ROLE ${RUNTIME_ROLE}`);

    const check = await client.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );
    const identity = check.rows[0];
    if (
      !identity ||
      identity.current_user !== RUNTIME_ROLE ||
      identity.rolsuper ||
      identity.rolbypassrls
    ) {
      throw new Error(
        `Unsafe database runtime identity: expected ${RUNTIME_ROLE} with RLS enforced.`,
      );
    }

    configuredClients.add(client);
    return client;
  } catch (err) {
    client.release(true);
    throw err;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type Sql = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null>;
};

function wrap(client: PoolClient): Sql {
  // node-postgres does not support overlapping client.query calls on one
  // checked-out client. Several service methods intentionally use
  // Promise.all for independent reads, so serialize them here while keeping
  // the service API concurrent-friendly.
  let tail: Promise<void> = Promise.resolve();

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
      return run(async () => {
        const res = await client.query<T>(text, params);
        return res.rows;
      });
    },
    one<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      return run(async () => {
        const res = await client.query<T>(text, params);
        return res.rows[0] ?? null;
      });
    },
  };
}

/**
 * Runs `fn` inside a transaction with the organization context set, so
 * every statement is checked by the row-level security policies.
 *
 * The setting is transaction-scoped (`set_config(..., true)`), which means
 * it cannot leak to the next borrower of this pooled connection.
 */
export async function withOrg<T>(
  organizationId: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await getRuntimeClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_organization_id',
      organizationId,
    ]);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Same as `withOrg` but the caller controls commit/rollback boundaries for
 * a multi-step operation that must be atomic across services.
 */
export async function withOrgTx<T>(
  organizationId: string,
  fn: (sql: Sql, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getRuntimeClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_organization_id',
      organizationId,
    ]);
    const result = await fn(wrap(client), client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For the few statements that legitimately run before an organization is
 * known (login, token exchange, worker queue polling). Only tables that
 * are exempt from row-level security may be touched here.
 */
export async function withoutOrg<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await getRuntimeClient();
  try {
    return await fn(wrap(client));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// Small query-building helpers. Everything is parameterised; no value is
// ever interpolated into SQL text.
// ---------------------------------------------------------------------

export class QueryBuilder {
  private readonly params: unknown[] = [];

  /** Registers a value and returns its placeholder, e.g. `$3`. */
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  values(): unknown[] {
    return this.params;
  }
}

/** Builds `col = $n, col2 = $m` from a partial record, skipping undefined. */
export function buildSet(
  qb: QueryBuilder,
  updates: Record<string, unknown>,
): { clause: string; fields: string[] } {
  const parts: string[] = [];
  const fields: string[] = [];
  for (const [column, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    parts.push(`${column} = ${qb.add(value)}`);
    fields.push(column);
  }
  return { clause: parts.join(', '), fields };
}
