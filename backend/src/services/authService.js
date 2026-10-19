const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { revokePresentedAccessToken } = require('./accessTokenRevocation');
const { hashRefreshToken } = require('../security/refreshTokenHash');

function positiveInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(503, 'CONFIG_ERROR', 'Login lockout configuration is invalid');
  }
  return parsed;
}

function defaultLockout() {
  return {
    maxAttempts: positiveInt(process.env.LOGIN_MAX_ATTEMPTS, 5),
    lockMs: positiveInt(process.env.LOGIN_LOCK_MINUTES, 15) * 60 * 1000,
  };
}

function assertSecret(config) {
  if (!config.jwt.secret) {
    throw new HttpError(503, 'CONFIG_ERROR', 'JWT_SECRET is not configured');
  }
}

function signAccessToken(config, employee) {
  return jwt.sign(
    { role: employee.role, email: employee.email, authMethod: 'password' },
    config.jwt.secret,
    { subject: employee.employeeUid, expiresIn: config.jwt.expiresIn, algorithm: 'HS256', jwtid: randomUUID() },
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

function createAuthService({ config, repositories, now = () => Date.now(), lockout = null }) {
  const refreshInflight = new Map();
  function policy() {
    const selected = lockout || defaultLockout();
    if (!Number.isInteger(selected.maxAttempts) || selected.maxAttempts <= 0
      || !Number.isInteger(selected.lockMs) || selected.lockMs <= 0) {
      throw new HttpError(503, 'CONFIG_ERROR', 'Login lockout configuration is invalid');
    }
    return selected;
  }

  async function persistFailure(employeeUid) {
    const selected = policy();
    try {
      await repositories.employees.recordFailedLogin(employeeUid, { ...selected, now });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'LOCKOUT_STATE_UNAVAILABLE', 'Login lockout state is unavailable');
    }
  }

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
        if (employee) await persistFailure(employee.employeeUid);
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
      let cleared;
      try {
        cleared = await repositories.employees.clearLoginAttempts(employee.employeeUid, now());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'LOCKOUT_STATE_UNAVAILABLE', 'Login lockout state is unavailable');
      }
      if (!cleared) {
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
      const key = hashRefreshToken(refreshToken);
      const pending = refreshInflight.get(key);
      if (pending) {
        await pending.catch(() => {});
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
      }
      const run = (async () => {
        if (typeof repositories.refreshTokens.rotate !== 'function') {
          throw new HttpError(503, 'REFRESH_STORE_UNAVAILABLE', 'Refresh token store is unavailable');
        }
        let result;
        try {
          result = await repositories.refreshTokens.rotate(refreshToken);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'REFRESH_STORE_UNAVAILABLE', 'Refresh token store is unavailable');
        }
        if (!result || result.outcome !== 'rotated') {
          throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
        }
        return {
          accessToken: signAccessToken(config, {
            employeeUid: result.employeeUid,
            role: result.role,
            email: result.email,
          }),
          refreshToken: result.refreshToken,
        };
      })();
      refreshInflight.set(key, run);
      try {
        return await run;
      } finally {
        refreshInflight.delete(key);
      }
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
      await revokePresentedAccessToken(repositories, auth);
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
