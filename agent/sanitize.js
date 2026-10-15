const { AgentCoreError } = require('./errors');

/**
 * Payload boundary for Agent Core.
 *
 * Names, citizen/National IDs, employee identifiers, attendance rows, access tokens
 * and raw logs must NEVER be sent to Agent Core. This module is the enforcement point:
 * `sanitizeContext` redacts/bounds a copy, `assertNoSensitiveContent` fails closed on
 * any forbidden key or credential-looking string.
 *
 * Credential heuristics mirror the repo's security posture: see
 * backend/src/security/nationalIdContract.js (SAFE_TEXT + the /\d{10,}/ rejection).
 */

const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'firstName',
  'lastName',
  'firstNameTh',
  'lastNameTh',
  'firstNameEn',
  'lastNameEn',
  'name',
  'displayName',
  'email',
  'phone',
  'nationalId',
  'national_id',
  'citizenId',
  'citizenID',
  'personnelId',
  'personnel_id',
  'employeeId',
  'employee_id',
  'employeeUid',
  'employee_uid',
  'facescanId',
  'facescan_id',
  'badgeNumber',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'api_key',
  'row',
  'rows',
  'attendanceRows',
  'events',
  'events_rows',
  'csv',
  'rawLog',
  'raw_log',
  'stack',
]);

const REDACTED = '<redacted>';
const MAX_DEPTH_MARKER = '<max-depth>';
const CIRCULAR_MARKER = '<circular>';

const FORBIDDEN_KEY_LOOKUP = new Set(FORBIDDEN_PAYLOAD_KEYS.map((key) => normalizeKey(key)));

// A long base64url/hex run (>= 40 chars), e.g. a bare API key or token body.
const LONG_SECRET_RUN = /[A-Za-z0-9+/=_-]{40,}/;
// A JWT: three base64url segments separated by dots.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 13-digit run (National ID length); the repo rejects /\d{10,}/ elsewhere.
const LONG_DIGIT_RUN = /\d{13,}/;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[_-]/g, '');
}

function isForbiddenKey(key) {
  return FORBIDDEN_KEY_LOOKUP.has(normalizeKey(key));
}

function looksLikeCredential(text) {
  return (
    typeof text === 'string'
    && (JWT_SHAPE.test(text)
      || EMAIL_SHAPE.test(text)
      || LONG_DIGIT_RUN.test(text)
      || LONG_SECRET_RUN.test(text))
  );
}

function sanitizeContext(value, { maxDepth = 6, maxArrayLength = 25, maxStringLength = 500 } = {}) {
  const redactions = [];
  const seen = new WeakSet();

  function walk(node, path, depth) {
    if (depth > maxDepth) {
      return MAX_DEPTH_MARKER;
    }
    if (node === null) {
      return null;
    }
    const type = typeof node;
    if (type === 'string') {
      return node.length > maxStringLength ? node.slice(0, maxStringLength) : node;
    }
    if (type === 'number' || type === 'boolean') {
      return node;
    }
    if (type === 'function' || type === 'symbol' || type === 'undefined' || type === 'bigint') {
      return undefined;
    }
    if (node instanceof Date) {
      return node.toISOString();
    }
    if (type !== 'object') {
      return undefined;
    }
    if (seen.has(node)) {
      return CIRCULAR_MARKER;
    }
    seen.add(node);

    let result;
    if (Array.isArray(node)) {
      result = [];
      const limit = Math.min(node.length, maxArrayLength);
      for (let index = 0; index < limit; index += 1) {
        const item = walk(node[index], `${path}[${index}]`, depth + 1);
        if (item !== undefined) {
          result.push(item);
        }
      }
      const dropped = node.length - limit;
      if (dropped > 0) {
        result.push(`<truncated:${dropped}>`);
      }
    } else {
      result = {};
      for (const key of Object.keys(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isForbiddenKey(key)) {
          result[key] = REDACTED;
          redactions.push(childPath);
          continue;
        }
        const child = walk(node[key], childPath, depth + 1);
        if (child !== undefined) {
          result[key] = child;
        }
      }
    }

    seen.delete(node);
    return result;
  }

  return { value: walk(value, '', 0), redactions };
}

/**
 * Throws when a forbidden key survives at any depth, or when a string value looks like
 * a credential. The message names the offending KEY PATH only, never the value.
 */
function assertNoSensitiveContent(payload) {
  function unsafe(reason) {
    return new AgentCoreError('AGENT_CORE_PAYLOAD_UNSAFE', `Unsafe Agent Core payload: ${reason}`);
  }

  function walk(node, path, depth) {
    if (node === null) {
      return;
    }
    const type = typeof node;
    if (type === 'string') {
      if (looksLikeCredential(node)) {
        throw unsafe(`credential-like value at "${path}"`);
      }
      return;
    }
    if (type !== 'object' || node instanceof Date) {
      return;
    }
    if (depth > 20) {
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      const childPath = path ? `${path}.${key}` : key;
      // Composable with sanitizeContext(): a key that was already redacted is reported by that function's
      // `redactions` list, not re-flagged here. Without this the documented sequence
      // `assertNoSensitiveContent(sanitizeContext(x).value)` would always throw, which is a trap.
      if (isForbiddenKey(key) && node[key] !== REDACTED) {
        throw unsafe(`forbidden key at "${childPath}"`);
      }
      walk(node[key], childPath, depth + 1);
    }
  }

  walk(payload, '', 0);
  return true;
}

module.exports = {
  FORBIDDEN_PAYLOAD_KEYS,
  assertNoSensitiveContent,
  sanitizeContext,
};
