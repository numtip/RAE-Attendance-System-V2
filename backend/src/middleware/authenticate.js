const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('../utils/httpError');

function authenticate(req, _res, next) {
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
  try {
    const payload = jwt.verify(match[1], config.jwt.secret);
    req.auth = {
      employeeUid: payload.sub,
      role: payload.role,
      email: payload.email,
    };
    next();
  } catch {
    next(new HttpError(401, 'UNAUTHORIZED', 'Access token is invalid'));
  }
}

module.exports = { authenticate };
