import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../src/api/operations';
import { allOperations, matchRoute, routeTable } from '../../src/api/registry';
import { RISK_MATRIX } from '../../src/domain/risk';

const operations = allOperations();

describe('operation registry', () => {
  it('registers a non-trivial number of operations', () => {
    expect(operations.length).toBeGreaterThan(90);
  });

  it('every operationId is unique', () => {
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation has a description long enough for a GPT to act on', () => {
    for (const op of operations) {
      expect(op.description.length, `${op.operationId} description too short`).toBeGreaterThan(40);
    }
  });

  it('every path parameter in the route is present in the input schema', () => {
    for (const op of operations) {
      const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (params.length === 0) continue;

      let schema: z.ZodTypeAny = op.input;
      while (schema instanceof z.ZodEffects) schema = schema._def.schema;
      expect(schema, `${op.operationId} input is not a ZodObject`).toBeInstanceOf(z.ZodObject);
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;

      for (const param of params) {
        expect(shape, `${op.operationId} missing path param "${param}" in schema`).toHaveProperty(param);
      }
    }
  });

  it('every operation with mayRequireConfirmation mentions confirmation in its description', () => {
    for (const op of operations) {
      if (!op.mayRequireConfirmation) continue;
      expect(op.description.toLowerCase(), op.operationId).toContain('confirm');
    }
  });

  it('every write operation (non-GET) declares a risk level', () => {
    for (const op of operations) {
      if (op.method === 'GET') continue;
      expect(['low', 'medium', 'high', 'critical']).toContain(op.riskLevel);
    }
  });

  it('critical-risk operations are marked internalOnly or require an explicit permission', () => {
    for (const op of operations) {
      if (op.riskLevel !== 'critical') continue;
      expect(op.internalOnly || Boolean(op.permission), op.operationId).toBeTruthy();
    }
  });

  it('routeTable has no duplicate method+path pairs', () => {
    const table = routeTable();
    const keys = table.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('route matching', () => {
  it('matches a static path over a parameterised one with the same shape', () => {
    const match = matchRoute('POST', '/sources/ingest-url');
    expect(match?.operation.operationId).toBe('ingestUrl');
  });

  it('matches a parameterised path and extracts the parameter', () => {
    const match = matchRoute('GET', '/sources/abc-123');
    expect(match?.operation.operationId).toBe('getSource');
    expect(match?.params).toEqual({ sourceId: 'abc-123' });
  });

  it('returns null for an unregistered path', () => {
    expect(matchRoute('GET', '/not/a/real/route')).toBeNull();
  });

  it('returns null when the method does not match any operation on that path', () => {
    expect(matchRoute('PUT', '/sources/ingest-url')).toBeNull();
  });
});

describe('risk matrix consistency', () => {
  it('every risk-matrix entry with a phrase corresponds to a confirmable level', () => {
    for (const [action, rule] of Object.entries(RISK_MATRIX)) {
      if (rule.level === 'high' || rule.level === 'critical') {
        expect(rule.phrase, `${action} should declare a confirmation phrase`).toBeTruthy();
      }
    }
  });
});
