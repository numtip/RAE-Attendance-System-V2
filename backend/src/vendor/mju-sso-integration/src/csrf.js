import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SsoError, SSO_ERROR_CODES } from './errors.js';

/** 256 bits of CSPRNG output, URL-safe. */
export function createCsrfToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison. Length is compared first because timingSafeEqual throws
 * on a length mismatch; that leak is unavoidable and harmless (length is not secret).
 * @param {unknown} expected
 * @param {unknown} provided
 */
export function verifyCsrf(expected, provided) {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof provided !== 'string' || provided === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Logout is POST-only. Returns the 405 payload a framework layer should send;
 * the `Allow` header is part of the requirement, not a nicety.
 * @param {string|undefined} method
 */
export function assertLogoutMethod(method) {
  if (String(method ?? '').toUpperCase() !== 'POST') {
    throw new SsoError(SSO_ERROR_CODES.LOGOUT_METHOD, {
      status: 405,
      message: 'Logout requires POST',
      details: { allow: 'POST' },
    });
  }
}

/**
 * Callback is GET-only: the provider redirects the browser, and accepting a POST
 * callback would widen the attack surface without any evidence the provider uses one.
 * @param {string|undefined} method
 */
export function assertCallbackMethod(method) {
  if (String(method ?? '').toUpperCase() !== 'GET') {
    throw new SsoError(SSO_ERROR_CODES.CALLBACK_METHOD, {
      status: 405,
      message: 'The SSO callback requires GET',
      details: { allow: 'GET' },
    });
  }
}
