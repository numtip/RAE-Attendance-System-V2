const { HttpError } = require('../utils/httpError');

function createSsoService({ config }) {
  function disabled() {
    if (config.sso.enabled) {
      throw new HttpError(503, 'SSO_NOT_READY', 'SSO callback registration is not confirmed');
    }
    throw new HttpError(403, 'SSO_DISABLED', 'SSO stays disabled until the MJU callback URL is confirmed');
  }
  return {
    login: async () => disabled(),
    callback: async () => disabled(),
    me: async () => disabled(),
    logout: async () => disabled(),
  };
}

module.exports = { createSsoService };
