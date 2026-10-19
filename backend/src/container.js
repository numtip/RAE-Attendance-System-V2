const config = require('./config');
const { HttpError } = require('./utils/httpError');
const { createFixtureRepositories } = require('./repositories/fixtureRepositories');
const { createMariaDbRepositories } = require('./repositories/mariadbRepositories');

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
  const repositories = dataSource === 'mariadb'
    ? createMariaDbRepositories(activeConfig.database)
    : createFixtureRepositories();
  return { config: activeConfig, dataSource, repositories };
}

module.exports = { createContainer };
