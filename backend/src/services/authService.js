const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');

function assertSecret(config) {
  if (!config.jwt.secret) {
    throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
  }
}

function signAccessToken(config, employee) {
  return jwt.sign(
    { role: employee.role, email: employee.email },
    config.jwt.secret,
    { subject: employee.employeeUid, expiresIn: config.jwt.expiresIn },
  );
}

async function logAuthEvent(repositories, entry) {
  if (!repositories.authLogs?.append) return;
  try {
    await repositories.authLogs.append(entry);
  } catch {
    // Auth must succeed even when audit logging fails.
  }
}

function createAuthService({ config, repositories }) {
  return {
    async login({ email, password, ipAddress, userAgent }) {
      assertSecret(config);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A valid email is required');
      }
      if (!password || String(password).length < 6) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Password must be at least 6 characters');
      }
      const employee = await repositories.employees.findByEmail(email);
      const matches = employee
        ? await bcrypt.compare(String(password), employee.passwordHash)
        : false;
      if (!employee || !matches) {
        await logAuthEvent(repositories, {
          employeeUid: employee?.employeeUid,
          email,
          eventType: 'failed_login',
          success: false,
          ipAddress,
          userAgent,
          errorMessage: 'Invalid credentials',
        });
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      if (employee.lockedUntil && new Date(employee.lockedUntil).getTime() > Date.now()) {
        await logAuthEvent(repositories, {
          employeeUid: employee.employeeUid,
          email: employee.email,
          eventType: 'locked',
          success: false,
          ipAddress,
          userAgent,
        });
        throw new HttpError(403, 'ACCOUNT_LOCKED', 'This account is locked');
      }
      const refreshToken = randomUUID();
      const expiresAt = new Date(Date.now() + config.jwt.refreshTokenDays * 86400000).toISOString();
      await repositories.refreshTokens.save({
        token: refreshToken,
        employeeUid: employee.employeeUid,
        role: employee.role,
        email: employee.email,
        expiresAt,
        revokedAt: null,
      });
      await logAuthEvent(repositories, {
        employeeUid: employee.employeeUid,
        email: employee.email,
        eventType: 'login',
        success: true,
        ipAddress,
        userAgent,
      });
      return {
        accessToken: signAccessToken(config, employee),
        refreshToken,
        employee: {
          employeeUid: employee.employeeUid,
          email: employee.email,
          role: employee.role,
        },
      };
    },

    async refresh({ refreshToken }) {
      assertSecret(config);
      if (!refreshToken) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'refreshToken is required');
      }
      const current = await repositories.refreshTokens.find(refreshToken);
      if (!current || current.revokedAt || new Date(current.expiresAt).getTime() <= Date.now()) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
      }
      await repositories.refreshTokens.revoke(refreshToken);
      const employee = {
        employeeUid: current.employeeUid,
        role: current.role,
        email: current.email,
      };
      const nextToken = randomUUID();
      await repositories.refreshTokens.save({
        token: nextToken,
        employeeUid: current.employeeUid,
        role: current.role,
        email: current.email,
        expiresAt: current.expiresAt,
        revokedAt: null,
      });
      return {
        accessToken: signAccessToken(config, employee),
        refreshToken: nextToken,
      };
    },

    async me(auth) {
      const employee = await repositories.employees.findByUid(auth.employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return employee;
    },

    async logout({ refreshToken, auth, ipAddress, userAgent }) {
      if (!refreshToken) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'refreshToken is required');
      }
      const current = await repositories.refreshTokens.find(refreshToken);
      if (!current || current.employeeUid !== auth.employeeUid) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
      }
      await repositories.refreshTokens.revoke(refreshToken);
      await logAuthEvent(repositories, {
        employeeUid: auth.employeeUid,
        email: current.email,
        eventType: 'logout',
        success: true,
        ipAddress,
        userAgent,
      });
      return { revoked: true };
    },
  };
}

module.exports = { createAuthService };
