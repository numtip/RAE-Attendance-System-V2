const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createSsoController(ssoService, { config }) {
  return {
    login: asyncRoute(async (_req, res) => {
      const url = await ssoService.beginLogin();
      res.redirect(302, url);
    }),
    callback: asyncRoute(async (req, res) => {
      await ssoService.handleCallback({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        error_description: req.query.error_description,
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
      success(res, data, 'ออกจาก SSO แล้ว');
    }),
  };
}

module.exports = { createSsoController };
