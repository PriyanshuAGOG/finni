/**
 * Stable error contract shared by the dashboard, the versioned API and
 * the Custom GPT actions. Error codes are part of the public contract:
 * add new ones freely, never repurpose an existing one.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  INVALID_INPUT: { status: 400, retryable: false },
  VALIDATION_FAILED: { status: 422, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  CONFLICT: { status: 409, retryable: false },
  DUPLICATE_SOURCE: { status: 409, retryable: false },
  CONFIRMATION_REQUIRED: { status: 428, retryable: true },
  CONFIRMATION_EXPIRED: { status: 410, retryable: true },
  RATE_LIMITED: { status: 429, retryable: true },
  PROCESSING: { status: 202, retryable: true },
  EXTRACTION_FAILED: { status: 422, retryable: true },
  AI_PROCESSING_FAILED: { status: 502, retryable: true },
  EXTERNAL_SEARCH_FAILED: { status: 502, retryable: true },
  JOB_NOT_CANCELLABLE: { status: 409, retryable: false },
  SOURCE_LOCKED: { status: 409, retryable: false },
  FIELD_LOCKED: { status: 409, retryable: false },
  VERSION_CONFLICT: { status: 409, retryable: true },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retryable: false },
  NOT_IMPLEMENTED: { status: 501, retryable: false },
  INTERNAL_ERROR: { status: 500, retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
    request_id: string;
    retryable: boolean;
    suggested_action?: string;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly suggestedAction?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>;
      suggestedAction?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? ERROR_CODES[code].retryable;
    this.suggestedAction = options.suggestedAction;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        request_id: requestId,
        retryable: this.retryable,
        ...(this.suggestedAction ? { suggested_action: this.suggestedAction } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------
// Constructors for the errors thrown most often, so call sites stay short
// and messages stay consistent.
// ---------------------------------------------------------------------

export const notFound = (resource: string, id?: string) =>
  new ApiError('NOT_FOUND', `The requested ${resource} could not be found.`, {
    details: id ? { resource, id } : { resource },
    suggestedAction: `Verify the ${resource} identifier, or search for it again.`,
  });

export const forbidden = (permission: string) =>
  new ApiError('FORBIDDEN', `You do not have the required permission: ${permission}.`, {
    details: { required_permission: permission },
    suggestedAction:
      'Ask an administrator to grant this permission. Do not retry with a different operation.',
  });

export const unauthenticated = (message = 'Authentication is required.') =>
  new ApiError('UNAUTHENTICATED', message, {
    suggestedAction: 'Connect or reconnect your Nirog Bhoomi Research OS account.',
  });

export const invalidInput = (message: string, details: Record<string, unknown> = {}) =>
  new ApiError('INVALID_INPUT', message, { details });

export const conflict = (message: string, details: Record<string, unknown> = {}) =>
  new ApiError('CONFLICT', message, { details });

export const versionConflict = (resource: string, currentVersion: number) =>
  new ApiError(
    'VERSION_CONFLICT',
    `The ${resource} changed after it was retrieved.`,
    {
      details: { resource, current_version: currentVersion },
      suggestedAction: 'Retrieve the latest version and reapply the change.',
    },
  );

export const fieldLocked = (fields: string[]) =>
  new ApiError(
    'FIELD_LOCKED',
    `These fields were locked by a reviewer and cannot be changed: ${fields.join(', ')}.`,
    {
      details: { locked_fields: fields },
      suggestedAction:
        'Ask a reviewer with source.lock_fields to unlock the fields before editing them.',
    },
  );

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
