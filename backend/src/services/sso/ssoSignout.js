/**
 * MJU SSO signout: URL construction and redirect safety.
 *
 * ## What the legacy sample does, and what we deliberately do differently
 *
 * `sso/sampleSignout.aspx.vb` performs three steps: `Session.RemoveAll()`, then it expires a cookie named with
 * its own session key **scoped to `Domain="mju.ac.th"`**, then redirects to
 * `https://sso.mju.ac.th/signout.aspx?cid=<its own clientID>`.
 *
 * Three things in that sequence must NOT be copied:
 *
 *  1. **The `mju.ac.th` cookie is not ours.** Setting `Domain=mju.ac.th` addresses a parent-domain cookie shared
 *     by every MJU subdomain. RAE V2 (`raeservice.mju.ac.th`) never sets a cookie on that domain, so expiring one
 *     would delete another application's state — the "do not delete unrelated cookies" rule. It is also a
 *     security smell in the original: a `Domain` cookie is readable by any sibling subdomain, so RAE V2 must
 *     never write one.
 *  2. **The sample client ID must never be used.** `sso/client_list.txt` registers RAE V2 under its own client
 *     ID and its own callback URL. Reusing the sample's ID would authenticate against the wrong registration.
 *     `assertNotSampleClientId` enforces that, so the mistake fails loudly instead of silently.
 *  3. **Expiry attributes were incomplete.** The sample sets only an expiry and a domain: no `Path`, no
 *     `Secure`, no `HttpOnly`, no `SameSite`. Anything RAE V2 ever sets must carry all five, or deletion will not
 *     match the original cookie and silently fail.
 *
 * ## Why this module is pure
 *
 * Every function here is a decision about a string — no I/O, no clock, no session, no cookie jar. That keeps the
 * open-redirect and client-ID rules testable without a browser, and keeps the HTTP layer limited to wiring.
 */

/**
 * The MJU sample's own client ID. Present only so it can be REJECTED. It is a public identifier published in the
 * sample source, not a secret; it must never be used to authenticate RAE V2.
 */
const SAMPLE_CLIENT_ID = '9c04eaddb9e248a095b9050cb929d914';

/** Client IDs in this ecosystem are 32 lowercase hex characters. */
const CLIENT_ID_SHAPE = /^[0-9a-f]{32}$/;

/** Schemes that must never appear in a redirect target. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

class SsoSignoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Rejects the sample's client ID and anything that is not a well-formed client ID.
 * The rejected value is not echoed, because it appears in logs and issue trackers.
 */
function assertNotSampleClientId(clientId) {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new SsoSignoutError('SSO_CLIENT_ID_MISSING', 'an SSO client ID must be configured');
  }
  const value = clientId.trim().toLowerCase();
  if (value === SAMPLE_CLIENT_ID) {
    throw new SsoSignoutError(
      'SSO_CLIENT_ID_IS_SAMPLE',
      'the sample client ID must never be used; use the RAE V2 registration',
    );
  }
  if (!CLIENT_ID_SHAPE.test(value)) {
    throw new SsoSignoutError('SSO_CLIENT_ID_INVALID', 'the SSO client ID is not 32 lowercase hex characters');
  }
  return value;
}

/**
 * Validates the MJU signout endpoint before it is used as a redirect target.
 *
 * Requirements: absolute `https:` URL, no embedded credentials, no fragment. The host is not pinned: the value
 * comes from operator configuration (`SSO_SIGNOUT_URL`), not from a request.
 */
function assertSignoutEndpoint(signoutUrl) {
  if (typeof signoutUrl !== 'string' || signoutUrl.trim() === '') {
    throw new SsoSignoutError('SSO_SIGNOUT_URL_MISSING', 'an SSO signout URL must be configured');
  }
  let url;
  try {
    url = new URL(signoutUrl.trim());
  } catch {
    throw new SsoSignoutError('SSO_SIGNOUT_URL_INVALID', 'the SSO signout URL is not an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new SsoSignoutError('SSO_SIGNOUT_URL_NOT_HTTPS', 'the SSO signout URL must use https');
  }
  if (url.username || url.password) {
    throw new SsoSignoutError('SSO_SIGNOUT_URL_HAS_CREDENTIALS', 'the SSO signout URL must not embed credentials');
  }
  if (url.hash) {
    throw new SsoSignoutError('SSO_SIGNOUT_URL_HAS_FRAGMENT', 'the SSO signout URL must not carry a fragment');
  }
  return url;
}

/**
 * Builds the MJU signout URL (`…/signout.aspx?cid=<clientId>`), replacing any `cid` already present so a stale
 * value in the environment is overwritten rather than appended.
 */
function buildSignoutUrl({ signoutUrl, clientId }) {
  const url = assertSignoutEndpoint(signoutUrl);
  url.searchParams.set('cid', assertNotSampleClientId(clientId));
  return url.toString();
}

/**
 * Resolves the post-signout landing page without becoming an open redirect.
 *
 * Accepted: a same-origin absolute URL, or a path on the allowed origin (`/attendance-v2/`). Rejected: any other
 * absolute host, protocol-relative `//host`, backslash tricks, scheme-relative encodings, `javascript:` and
 * friends, and anything with embedded credentials.
 *
 * `allowedOrigins` is explicit rather than derived from the request, because deriving it from `Host` is exactly
 * how open redirects are born.
 */
function resolveAfterSignoutUrl({ candidate, allowedOrigins = [], fallback = null }) {
  if (candidate == null || candidate === '') {
    if (fallback == null) {
      throw new SsoSignoutError('SSO_AFTER_SIGNOUT_MISSING', 'no post-signout URL is configured');
    }
    return resolveAfterSignoutUrl({ candidate: fallback, allowedOrigins, fallback: null });
  }
  if (typeof candidate !== 'string') {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_INVALID', 'the post-signout URL must be a string');
  }

  const raw = candidate.trim();
  if (raw === '') {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_INVALID', 'the post-signout URL must not be blank');
  }
  // Control characters and backslashes are used to smuggle a different host past naive parsers. Checked by code
  // point rather than a regex literal, so no control characters appear in this source file.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      throw new SsoSignoutError(
        'SSO_AFTER_SIGNOUT_INVALID',
        'the post-signout URL contains control or backslash characters',
      );
    }
  }
  const lower = raw.toLowerCase();
  for (const scheme of FORBIDDEN_SCHEMES) {
    if (lower.startsWith(scheme)) {
      throw new SsoSignoutError('SSO_AFTER_SIGNOUT_SCHEME', 'the post-signout URL uses a forbidden scheme');
    }
  }
  // `//evil.example` is protocol-relative: it inherits the scheme and leaves the site.
  if (raw.startsWith('//')) {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_OFFSITE', 'a protocol-relative redirect is not allowed');
  }

  const originList = allowedOrigins
    .map((entry) => String(entry || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // A path-only value is resolved against the single allowed origin, if exactly one is configured.
  if (raw.startsWith('/')) {
    if (originList.length !== 1) {
      throw new SsoSignoutError(
        'SSO_AFTER_SIGNOUT_AMBIGUOUS',
        'a relative post-signout path needs exactly one allowed origin',
      );
    }
    const resolved = new URL(raw, `${originList[0]}/`);
    if (`${resolved.protocol}//${resolved.host}` !== new URL(originList[0]).origin) {
      throw new SsoSignoutError('SSO_AFTER_SIGNOUT_OFFSITE', 'the post-signout path resolves off-site');
    }
    return resolved.toString();
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_INVALID', 'the post-signout URL is not absolute');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_SCHEME', 'the post-signout URL must be http(s)');
  }
  if (parsed.username || parsed.password) {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_HAS_CREDENTIALS', 'the post-signout URL must not embed credentials');
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!originList.includes(origin)) {
    throw new SsoSignoutError('SSO_AFTER_SIGNOUT_OFFSITE', 'the post-signout URL is not in the allowed origin list');
  }
  return parsed.toString();
}

/**
 * The cookie attributes RAE V2 would need IF it ever set an auth cookie.
 *
 * RAE V2 currently authenticates with a bearer token held in `localStorage`, so it sets no auth cookie at all and
 * there is nothing to clear on logout. This descriptor exists so that a future cookie-based session cannot be
 * introduced with the sample's incomplete attributes: `Path` must match the original exactly or the browser keeps
 * the cookie, and `Secure`/`HttpOnly`/`SameSite` are the baseline for a session cookie.
 */
function ownedSessionCookieDescriptor({ name, path = '/', domain = null, secure = true } = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new SsoSignoutError('SSO_COOKIE_NAME_INVALID', 'the cookie name is not a legal cookie token');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new SsoSignoutError('SSO_COOKIE_PATH_INVALID', 'the cookie path must start with "/"');
  }
  // A parent-domain cookie (e.g. mju.ac.th) is readable by every sibling subdomain. Refuse it outright.
  if (domain != null && String(domain).trim() !== '') {
    throw new SsoSignoutError(
      'SSO_COOKIE_DOMAIN_NOT_ALLOWED',
      'RAE V2 must not set a parent-domain cookie; use a host-only cookie',
    );
  }
  return Object.freeze({
    name,
    path,
    hostOnly: true,
    secure,
    httpOnly: true,
    sameSite: 'Lax',
    // Deletion attributes are the same as the creation attributes, which is the only way a browser removes it.
    expiresEpochMs: 0,
  });
}

module.exports = {
  SAMPLE_CLIENT_ID,
  SsoSignoutError,
  assertNotSampleClientId,
  assertSignoutEndpoint,
  buildSignoutUrl,
  resolveAfterSignoutUrl,
  ownedSessionCookieDescriptor,
};
