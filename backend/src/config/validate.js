/**
 * Runtime configuration validation.
 *
 * Fails closed in production so a container cannot report healthy while every
 * authenticated route returns 503. Never includes a secret value in a message:
 * errors carry a code plus a fixed description only.
 */

const MIN_JWT_SECRET_LENGTH = 16;

// Values that ship in the repo as placeholders and must never reach a real host.
const PLACEHOLDER_JWT_SECRETS = new Set(['dev-only-change-me', 'replace-at-runtime']);

function isProduction(config) {
  return config?.app?.env === 'production';
}

function resolveDataSources(config, env) {
  const dataSource = env.DATA_SOURCE || 'fixture';
  return { dataSource, appEnv: config?.app?.env || 'development' };
}

/**
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string }> }}
 */
function validateRuntimeConfig(config, options = {}) {
  const env = options.env || process.env;
  const production = options.production ?? isProduction(config);
  if (!production) {
    return { ok: true, errors: [] };
  }

  const { dataSource } = resolveDataSources(config, env);
  const errors = [];

  const jwtSecret = String(config?.jwt?.secret || '');
  if (!jwtSecret) {
    errors.push({ code: 'JWT_SECRET_MISSING', message: 'JWT_SECRET must be set' });
  } else if (PLACEHOLDER_JWT_SECRETS.has(jwtSecret)) {
    errors.push({
      code: 'JWT_SECRET_PLACEHOLDER',
      message: 'JWT_SECRET still holds a repository placeholder value',
    });
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push({
      code: 'JWT_SECRET_TOO_SHORT',
      message: `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`,
    });
  }

  if (dataSource !== 'mariadb') {
    errors.push({
      code: 'DATA_SOURCE_INVALID',
      message: 'DATA_SOURCE must be mariadb in production',
    });
  }

  const database = config?.database || {};
  for (const [code, field, label] of [
    ['DB_HOST_MISSING', 'host', 'DB_HOST'],
    ['DB_NAME_MISSING', 'name', 'DB_NAME'],
    ['DB_USER_MISSING', 'user', 'DB_USER'],
    ['DB_PASSWORD_MISSING', 'password', 'DB_PASSWORD'],
  ]) {
    if (!database[field]) {
      errors.push({ code, message: `${label} must be set` });
    }
  }

  return { ok: errors.length === 0, errors };
}

function assertRuntimeConfig(config, options = {}) {
  const result = validateRuntimeConfig(config, options);
  if (result.ok) return;
  const { HttpError } = require('../utils/httpError');
  const codes = result.errors.map((error) => error.code).join(', ');
  throw new HttpError(503, 'CONFIG_INVALID', `Runtime configuration is invalid: ${codes}`);
}

module.exports = {
  MIN_JWT_SECRET_LENGTH,
  PLACEHOLDER_JWT_SECRETS,
  assertRuntimeConfig,
  validateRuntimeConfig,
};
