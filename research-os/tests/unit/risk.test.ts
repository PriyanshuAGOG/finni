import { describe, expect, it, beforeEach } from 'vitest';
import { effectiveRisk, requiresConfirmation, confirmationPhrase } from '../../src/domain/risk';
import { resetEnvCache } from '../../src/lib/env';

beforeEach(() => {
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  resetEnvCache();
});

describe('effectiveRisk', () => {
  it('rates a read operation as low risk', () => {
    expect(effectiveRisk('searchKnowledge')).toBe('low');
  });

  it('rates a single-record archive as high risk', () => {
    expect(effectiveRisk('archiveSource')).toBe('high');
  });

  it('rates permanent deletion as critical', () => {
    expect(effectiveRisk('permanentlyDeleteSource')).toBe('critical');
  });

  it('escalates a batch review-status change past the configured threshold', () => {
    const small = effectiveRisk('changeSourceReviewStatus', { affectedCount: 1 });
    const large = effectiveRisk('changeSourceReviewStatus', { affectedCount: 500 });
    expect(small).toBe('medium');
    expect(large).toBe('high');
  });

  it('escalates updateClaim to high when the target is approved', () => {
    expect(effectiveRisk('updateClaim', { targetApproved: false })).toBe('medium');
    expect(effectiveRisk('updateClaim', { targetApproved: true })).toBe('high');
  });

  it('escalates updateClaim to high when the target is safety-relevant even if unapproved', () => {
    expect(effectiveRisk('updateClaim', { targetApproved: false, safetyRelevant: true })).toBe('high');
  });

  it('treats an unregistered operation as medium risk rather than silently safe', () => {
    expect(effectiveRisk('someOperationNobodyDefined')).toBe('medium');
  });
});

describe('requiresConfirmation', () => {
  it('does not require confirmation for low-risk operations', () => {
    expect(requiresConfirmation('searchKnowledge')).toBe(false);
  });

  it('does not require confirmation for medium-risk operations', () => {
    expect(requiresConfirmation('updateSource')).toBe(false);
  });

  it('requires confirmation for high-risk operations', () => {
    expect(requiresConfirmation('archiveSource')).toBe(true);
  });

  it('requires confirmation for critical operations', () => {
    expect(requiresConfirmation('permanentlyDeleteSource')).toBe(true);
  });

  it('requires confirmation once a batch escalates to high risk', () => {
    expect(requiresConfirmation('changeSourceReviewStatus', { affectedCount: 1 })).toBe(false);
    expect(requiresConfirmation('changeSourceReviewStatus', { affectedCount: 500 })).toBe(true);
  });
});

describe('confirmationPhrase', () => {
  it('returns a distinct phrase per action type', () => {
    expect(confirmationPhrase('archiveSource')).toBe('CONFIRM ARCHIVE');
    expect(confirmationPhrase('mergeCategories')).toBe('CONFIRM MERGE');
    expect(confirmationPhrase('permanentlyDeleteSource')).toBe('PERMANENTLY DELETE');
  });

  it('falls back to a generic phrase for an unknown action', () => {
    expect(confirmationPhrase('unknownAction')).toBe('CONFIRM');
  });
});
