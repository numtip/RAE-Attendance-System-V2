const config = require('../config');
const { getDbUnavailableError, getPool, isDatabaseConfigured } = require('../db/pool');
const { createAttendanceMariaDbRepository } = require('./mariadb/attendanceMariaDbRepository');
const { createAuthLogsMariaDbRepository } = require('./mariadb/authLogsMariaDbRepository');
const { createEmployeeMariaDbRepository } = require('./mariadb/employeeMariaDbRepository');
const { createLeaveMariaDbRepository } = require('./mariadb/leaveMariaDbRepository');
const { createRefreshTokenMariaDbRepository } = require('./mariadb/refreshTokenMariaDbRepository');

function blockedRepo() {
  const error = getDbUnavailableError();
  const fail = async () => {
    throw error;
  };
  return new Proxy({}, { get: () => fail });
}

function createMariaDbRepositories(database = config.database) {
  if (!isDatabaseConfigured(database)) {
    return {
      employees: blockedRepo(),
      attendance: blockedRepo(),
      leave: blockedRepo(),
      refreshTokens: blockedRepo(),
      authLogs: blockedRepo(),
    };
  }

  const pool = getPool(database);
  return {
    employees: createEmployeeMariaDbRepository(pool),
    attendance: createAttendanceMariaDbRepository(pool),
    leave: createLeaveMariaDbRepository(pool),
    refreshTokens: createRefreshTokenMariaDbRepository(pool),
    authLogs: createAuthLogsMariaDbRepository(pool),
  };
}

module.exports = { createMariaDbRepositories, isDatabaseConfigured };
