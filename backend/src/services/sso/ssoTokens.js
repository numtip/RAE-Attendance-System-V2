const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../../utils/httpError');

function assertJwtSecret(config) {
  if (!config.jwt.secret) {
    throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
  }
}

function signAccessToken(config, employee, authMethod = 'sso') {
  return jwt.sign(
    { role: employee.role, email: employee.email, authMethod },
    config.jwt.secret,
    { subject: employee.employeeUid, expiresIn: config.jwt.expiresIn, algorithm: 'HS256', jwtid: randomUUID() },
  );
}

module.exports = { assertJwtSecret, signAccessToken };
