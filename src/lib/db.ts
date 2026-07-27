import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getEnv } from './env';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const env = getEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
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
  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
      const res = await client.query<T>(text, params);
      return res.rows;
    },
    async one<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      const res = await client.query<T>(text, params);
      return res.rows[0] ?? null;
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
  const client = await getPool().connect();
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
  const client = await getPool().connect();
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
  const client = await getPool().connect();
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
