const { randomBytes } = require('node:crypto');
const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function cookieNames(req) {
  const header = req.headers?.cookie;
  if (!header) return [];
  return header.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean);
}

/**
 * Minimal Cookie header parsing. The project has no cookie-parser dependency and this is the
 * first cookie it sets, so a parser is inlined rather than added.
 */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header || !name) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // A malformed value is treated as absent: the attempt then fails closed.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Browser binding for a login attempt (G-02).
 *
 * MJU does not echo `state` (docs/SSO_PROTOCOL_EVIDENCE.md), so nothing in the provider's
 * callback ties the response to the request that started it. A server-generated random value,
 * stored only as a SHA-256 digest server-side and carried in an HttpOnly cookie, at least proves
 * that THIS browser started a login here, and that the attempt is single use within its TTL.
 *
 * Residual risk (documented, not hidden): inside a browser that has just started a login, an
 * attacker-supplied callback cannot be distinguished from the provider's. Only MJU echoing a
 * pass-through value closes that. This control narrows the window; it does not close it.
 */
function createSsoController(ssoService, { config }) {
  const isProduction = config.env === 'production';
  const cookieName = config.sso.loginBindingCookie;
  const ttlMs = config.sso.loginBindingTtlMs;

  // SameSite=Lax: the provider returns with a top-level GET, which Lax cookies accompany.
  // Path is narrow: the binding is only ever needed by the two SSO endpoints.
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction, // the dev server is http, so Secure would make the cookie unsettable
    path: '/api/v1/auth/sso',
    maxAge: ttlMs,
  };

  function setBindingCookie(res, value) {
    res.cookie(cookieName, value, cookieOptions);
  }

  function clearBindingCookie(res) {
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
  }

  return {
    login: asyncRoute(async (req, res) => {
      // Always a fresh server-generated value. A client-supplied one is never adopted, which
      // removes session-fixation style attacks on the binding itself.
      const browserBinding = randomBytes(32).toString('base64url');
      const url = await ssoService.beginLogin({ browserBinding });
      setBindingCookie(res, browserBinding);
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(302, url);
    }),
    callback: asyncRoute(async (req, res) => {
      const browserBinding = readCookie(req, cookieName);
      // Single use whatever the outcome: clear before the exchange so a retry cannot reuse it.
      clearBindingCookie(res);
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');

      await ssoService.handleCallback({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        error_description: req.query.error_description,
        rawQuery: req.query,
        method: req.method,
        rawBody: req.body,
        cookieNames: cookieNames(req),
        browserBinding,
      });
      const redirectBase = config.app.url.replace(/\/$/, '');
      const target = new URL(`${redirectBase}/`);
      target.searchParams.set('sso', 'success');
      res.redirect(302, target.toString());
    }),
    me: asyncRoute(async (req, res) => {
      const data = await ssoService.me(req.auth);
      success(res, data, 'ข้อมูลผู้ใช้ SSO');
    }),
    logout: asyncRoute(async (req, res) => {
      const data = await ssoService.logout({
        refreshToken: req.body?.refreshToken,
        auth: req.auth,
      });
      // A logout ends the browser's login attempt too, so a half-finished login cannot be
      // resumed after the user asked to be signed out.
      clearBindingCookie(res);
      success(res, data, 'ออกจาก SSO แล้ว');
    }),
  };
}

module.exports = { createSsoController, readCookie };
