const { randomBytes } = require('node:crypto');
const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');
const { isProduction } = require('../services/sso/ssoConfig');

const BINDING_COOKIE = 'rae_sso_bind';
const BINDING_COOKIE_PATH = '/api/v1/auth/sso';
const BINDING_TTL_MS = 10 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = part.slice(index + 1).trim();
  }
  return out;
}

function cookieNames(req) {
  return Object.keys(parseCookies(req));
}

function createSsoController(ssoService, { config }) {
  const secure = isProduction(config);
  // SameSite=Lax: the IdP returns to the callback with a top-level GET, which Lax cookies accompany.
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure, path: BINDING_COOKIE_PATH };

  function noStore(res) {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }

  return {
    login: asyncRoute(async (_req, res) => {
      // Always a fresh server-generated binding: a value supplied by the client (fixation) is never reused.
      const browserBinding = randomBytes(24).toString('hex');
      const url = await ssoService.beginLogin({ browserBinding });
      res.cookie(BINDING_COOKIE, browserBinding, { ...cookieOptions, maxAge: BINDING_TTL_MS });
      noStore(res);
      res.redirect(302, url);
    }),
    callback: asyncRoute(async (req, res) => {
      noStore(res);
      const browserBinding = parseCookies(req)[BINDING_COOKIE];
      // The binding is single use whatever the outcome.
      res.clearCookie(BINDING_COOKIE, cookieOptions);
      const session = await ssoService.handleCallback({
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
      const handoffCode = ssoService.issueLoginHandoff(session);
      const redirectBase = config.app.url.replace(/\/$/, '');
      const target = new URL(`${redirectBase}/auth/sso/complete`);
      target.searchParams.set('code', handoffCode);
      res.redirect(302, target.toString());
    }),
    exchange: asyncRoute(async (req, res) => {
      noStore(res);
      const data = await ssoService.exchangeLoginHandoff({ code: req.body?.code });
      success(res, data, 'เข้าสู่ระบบ SSO สำเร็จ');
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
      success(res, data, 'ออกจาก SSO แล้ว');
    }),
  };
}

module.exports = { createSsoController };
