const { asyncRoute } = require('../utils/asyncRoute');

function createSsoController(ssoService) {
  return {
    login: asyncRoute(async () => ssoService.login()),
    callback: asyncRoute(async () => ssoService.callback()),
    me: asyncRoute(async () => ssoService.me()),
    logout: asyncRoute(async () => ssoService.logout()),
  };
}

module.exports = { createSsoController };
