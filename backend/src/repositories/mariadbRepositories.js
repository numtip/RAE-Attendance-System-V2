const { HttpError } = require('../utils/httpError');

const blocked = new HttpError(
  503,
  'DB_UNAVAILABLE',
  'Production tables are not readable because the InnoDB dictionary was reinitialized (ERROR 1932). No connection was opened.',
);

function blockedRepo() {
  const fail = async () => {
    throw blocked;
  };
  return new Proxy({}, { get: () => fail });
}

function createMariaDbRepositories() {
  return {
    employees: blockedRepo(),
    attendance: blockedRepo(),
    leave: blockedRepo(),
    refreshTokens: blockedRepo(),
  };
}

module.exports = { createMariaDbRepositories };
