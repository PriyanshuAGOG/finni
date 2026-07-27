import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODES, fieldLocked, notFound, versionConflict } from '../../src/lib/errors';

describe('ApiError', () => {
  it('maps its code to the correct HTTP status', () => {
    expect(new ApiError('NOT_FOUND', 'x').status).toBe(404);
    expect(new ApiError('FORBIDDEN', 'x').status).toBe(403);
    expect(new ApiError('CONFIRMATION_REQUIRED', 'x').status).toBe(428);
    expect(new ApiError('INTERNAL_ERROR', 'x').status).toBe(500);
  });

  it('every declared error code has a status and retryable default', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(typeof spec.status).toBe('number');
      expect(typeof spec.retryable).toBe('boolean');
      void code;
    }
  });

  it('serializes to the documented envelope shape', () => {
    const err = new ApiError('VALIDATION_FAILED', 'Bad input', {
      details: { fields: { name: 'required' } },
      suggestedAction: 'Fix the field.',
    });
    const body = err.toBody('req_abc123');
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Bad input',
        details: { fields: { name: 'required' } },
        request_id: 'req_abc123',
        retryable: false,
        suggested_action: 'Fix the field.',
      },
    });
  });

  it('omits suggested_action when none was given', () => {
    const body = new ApiError('NOT_FOUND', 'gone').toBody('req_1');
    expect(body.error).not.toHaveProperty('suggested_action');
  });
});

describe('error constructors', () => {
  it('notFound names the resource', () => {
    const err = notFound('source', 'abc-123');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details.resource).toBe('source');
    expect(err.details.id).toBe('abc-123');
  });

  it('versionConflict is retryable and reports the current version', () => {
    const err = versionConflict('claim', 7);
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.retryable).toBe(true);
    expect(err.details.current_version).toBe(7);
  });

  it('fieldLocked lists every locked field', () => {
    const err = fieldLocked(['title', 'abstract']);
    expect(err.code).toBe('FIELD_LOCKED');
    expect(err.message).toContain('title');
    expect(err.message).toContain('abstract');
  });
});
