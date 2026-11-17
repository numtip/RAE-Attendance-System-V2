/**
 * Error model.
 *
 * Every failure keeps two things separate:
 *   - `code`   machine-readable, safe to log
 *   - `message` operator-facing, never contains provider payloads, codes or PII
 * A framework layer maps `status` + `code` to a response. Nothing here echoes a
 * provider body, so an error can never leak an identity document.
 */
export class SsoError extends Error {
  /**
   * @param {string} code stable error code (see SSO_ERROR_CODES)
   * @param {{status?: number, message?: string, details?: Record<string, unknown>}} [options]
   */
  constructor(code, { status = 400, message = 'Authentication failed', details } = {}) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
    this.status = status;
    this.expose = true;
    // `details` must only ever carry non-sensitive structural facts (names, lengths,
    // outcomes). Callers are responsible for that; the redactor drops unknown keys.
    if (details) this.details = details;
  }
}

export const SSO_ERROR_CODES = Object.freeze({
  NOT_READY: 'SSO_NOT_READY',
  DISABLED: 'SSO_DISABLED',
  CONFIG_INVALID: 'SSO_CONFIG_INVALID',
  UNTRUSTED_ENDPOINT: 'SSO_UNTRUSTED_ENDPOINT',

  CALLBACK_METHOD: 'SSO_CALLBACK_METHOD',
  CALLBACK_INVALID: 'SSO_CALLBACK_INVALID',
  CALLBACK_DUPLICATE: 'SSO_CALLBACK_DUPLICATE',
  ATTEMPT_MISSING: 'SSO_ATTEMPT_MISSING',
  ATTEMPT_EXPIRED: 'SSO_ATTEMPT_EXPIRED',
  CODE_REPLAY: 'SSO_CODE_REPLAY',
  CODE_REJECTED: 'SSO_CODE_REJECTED',

  PROVIDER_ERROR: 'SSO_PROVIDER_ERROR',
  PROVIDER_TIMEOUT: 'SSO_PROVIDER_TIMEOUT',
  RESPONSE_INVALID: 'SSO_RESPONSE_INVALID',
  RESPONSE_TOO_LARGE: 'SSO_RESPONSE_TOO_LARGE',

  SUBJECT_MISSING: 'SSO_SUBJECT_MISSING',
  SUBJECT_AMBIGUOUS: 'SSO_SUBJECT_AMBIGUOUS',
  SUBJECT_INVALID: 'SSO_SUBJECT_INVALID',
  IDENTITY_UNLINKED: 'SSO_IDENTITY_UNLINKED',
  IDENTITY_NOT_APPROVED: 'SSO_IDENTITY_NOT_APPROVED',
  IDENTITY_DISABLED: 'SSO_IDENTITY_DISABLED',
  IDENTITY_CONFLICT: 'SSO_IDENTITY_CONFLICT',
  IDENTITY_KEY_INVALID: 'SSO_IDENTITY_KEY_INVALID',
  IDENTITY_LINK_INVALID: 'SSO_IDENTITY_LINK_INVALID',
  IDENTITY_EMPLOYEE_UNKNOWN: 'SSO_IDENTITY_EMPLOYEE_UNKNOWN',
  IDENTITY_PROVENANCE_INVALID: 'SSO_IDENTITY_PROVENANCE_INVALID',

  SESSION_ROTATION: 'SSO_SESSION_ROTATION',
  SESSION_REQUIRED: 'SSO_SESSION_REQUIRED',

  CSRF_INVALID: 'SSO_CSRF_INVALID',
  LOGOUT_METHOD: 'SSO_LOGOUT_METHOD',
  RATE_LIMITED: 'SSO_RATE_LIMITED',
});

/** Convert anything thrown into a safe, loggable shape. */
export function toPublicError(error) {
  if (error instanceof SsoError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  // Unknown failures are deliberately opaque: no stack, no message.
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Authentication failed' };
}
