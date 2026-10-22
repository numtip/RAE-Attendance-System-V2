const config = require('./config');
const { HttpError } = require('./utils/httpError');
const { createFixtureRepositories } = require('./repositories/fixtureRepositories');
const { createMariaDbRepositories } = require('./repositories/mariadbRepositories');
const { protectorFromEnv, NationalIdError } = require('./security/nationalIdContract');

/**
 * Builds the national-ID protector, or `null` when no key is configured.
 *
 * A missing key must NOT stop the application: national-ID matching is simply unavailable, and every path that
 * needs it fails closed (503 `NATIONAL_ID_MATCHING_UNAVAILABLE`). Booting with a broken but "working" identity
 * path would be worse than not booting, so the only alternative considered — falling back to plaintext or to an
 * unkeyed hash — is deliberately not implemented.
 */
function buildNationalIdProtector(env) {
  try {
    return protectorFromEnv(env);
  } catch (error) {
    if (error instanceof NationalIdError) return null;
    throw error;
  }
}

function createContainer(options = {}) {
  const activeConfig = options.config || config;
  const dataSource = options.dataSource || process.env.DATA_SOURCE || 'fixture';
  if (activeConfig.app?.env === 'production' && dataSource !== 'mariadb') {
    throw new HttpError(
      503,
      'REVOCATION_STORE_UNAVAILABLE',
      'Production access-token revocation requires MariaDB',
    );
  }
  const repositories = options.repositories
    || (dataSource === 'mariadb'
      ? createMariaDbRepositories(activeConfig.database)
      : createFixtureRepositories());
  const nationalIdProtector = Object.prototype.hasOwnProperty.call(options, 'nationalIdProtector')
    ? options.nationalIdProtector
    : buildNationalIdProtector(process.env);
  return { config: activeConfig, dataSource, repositories, nationalIdProtector };
}

module.exports = { createContainer, buildNationalIdProtector };
