const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('../utils/httpError');

function createAuthenticate(revocations) {
  return function authenticate(req, _res, next) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      next(new HttpError(401, 'UNAUTHORIZED', 'Access token is required'));
      return;
    }
    if (!config.jwt.secret) {
      next(new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured'));
      return;
    }
    let payload;
    try {
      payload = jwt.verify(match[1], config.jwt.secret, { algorithms: ['HS256'] });
    } catch {
      next(new HttpError(401, 'UNAUTHORIZED', 'Access token is invalid'));
      return;
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0 || !payload.exp) {
      next(new HttpError(401, 'UNAUTHORIZED', 'Access token is invalid'));
      return;
    }
    if (!revocations || typeof revocations.isRevoked !== 'function') {
      next(new HttpError(503, 'REVOCATION_STORE_UNAVAILABLE', 'Access token revocation state is unavailable'));
      return;
    }
    revocations.isRevoked(payload.jti).then((revoked) => {
      if (revoked) {
        next(new HttpError(401, 'ACCESS_TOKEN_REVOKED', 'Access token has been revoked'));
        return;
      }
      req.auth = {
        employeeUid: payload.sub,
        role: payload.role,
        email: payload.email,
        authMethod: payload.authMethod,
        jti: payload.jti,
        accessTokenExpiresAt: new Date(payload.exp * 1000).toISOString(),
      };
      next();
    }).catch((error) => {
      if (error instanceof HttpError) {
        next(error);
        return;
      }
      next(new HttpError(503, 'REVOCATION_STORE_UNAVAILABLE', 'Access token revocation state is unavailable'));
    });
  };
}

module.exports = { createAuthenticate };
