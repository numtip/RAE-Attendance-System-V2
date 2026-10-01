const config = require('./config');
const { createFixtureRepositories } = require('./repositories/fixtureRepositories');
const { createMariaDbRepositories } = require('./repositories/mariadbRepositories');

function createContainer(options = {}) {
  const dataSource = options.dataSource || process.env.DATA_SOURCE || 'fixture';
  const repositories = dataSource === 'mariadb'
    ? createMariaDbRepositories()
    : createFixtureRepositories();
  return { config, dataSource, repositories };
}

module.exports = { createContainer };
