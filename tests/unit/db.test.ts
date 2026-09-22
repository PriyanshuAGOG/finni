import { describe, expect, it } from 'vitest';
import { normalizePostgresConnectionString } from '../../src/lib/db';

describe('normalizePostgresConnectionString', () => {
  it('upgrades sslmode=require to verify-full and preserves other parameters', () => {
    const input =
      'postgresql://user:pass@example.neon.tech/neondb?sslmode=require&channel_binding=require';
    const result = normalizePostgresConnectionString(input);
    const url = new URL(result);

    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('channel_binding')).toBe('require');
  });

  it('upgrades prefer and verify-ca to verify-full', () => {
    expect(
      new URL(
        normalizePostgresConnectionString(
          'postgresql://user:pass@example.test/db?sslmode=prefer',
        ),
      ).searchParams.get('sslmode'),
    ).toBe('verify-full');

    expect(
      new URL(
        normalizePostgresConnectionString(
          'postgresql://user:pass@example.test/db?sslmode=verify-ca',
        ),
      ).searchParams.get('sslmode'),
    ).toBe('verify-full');
  });

  it('leaves verify-full and URLs without sslmode unchanged', () => {
    const verifyFull = 'postgresql://user:pass@example.test/db?sslmode=verify-full';
    const noMode = 'postgresql://user:pass@example.test/db';

    expect(normalizePostgresConnectionString(verifyFull)).toBe(verifyFull);
    expect(normalizePostgresConnectionString(noMode)).toBe(noMode);
  });

  it('leaves malformed connection strings for pg to diagnose', () => {
    const malformed = 'not a postgres url';
    expect(normalizePostgresConnectionString(malformed)).toBe(malformed);
  });
});
