const { success } = require('../utils/response');
const { asyncRoute } = require('../utils/asyncRoute');

function createAuthController(authService) {
  return {
    login: asyncRoute(async (req, res) => {
      const data = await authService.login({
        email: req.body?.email,
        password: req.body?.password,
      });
      success(res, data, 'เข้าสู่ระบบสำเร็จ');
    }),
    refresh: asyncRoute(async (req, res) => {
      const data = await authService.refresh({ refreshToken: req.body?.refreshToken });
      success(res, data, 'ต่ออายุโทเค็นแล้ว');
    }),
    me: asyncRoute(async (req, res) => {
      const data = await authService.me(req.auth);
      success(res, data, 'ข้อมูลผู้ใช้ปัจจุบัน');
    }),
    logout: asyncRoute(async (req, res) => {
      const data = await authService.logout({
        refreshToken: req.body?.refreshToken,
        auth: req.auth,
      });
      success(res, data, 'ออกจากระบบแล้ว');
    }),
  };
}

module.exports = { createAuthController };
