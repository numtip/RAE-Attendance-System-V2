const config = require('../config');
const { getDbUnavailableError, getPool, isDatabaseConfigured } = require('../db/pool');
const { createAttendanceMariaDbRepository } = require('./mariadb/attendanceMariaDbRepository');
const { createAttendanceEventMariaDbRepository } = require('./mariadb/attendanceEventMariaDbRepository');
const { createAuthLogsMariaDbRepository } = require('./mariadb/authLogsMariaDbRepository');
const { createEmployeeMariaDbRepository } = require('./mariadb/employeeMariaDbRepository');
const { createLeaveMariaDbRepository } = require('./mariadb/leaveMariaDbRepository');
const { createLeaveRecordMariaDbRepository } = require('./mariadb/leaveRecordMariaDbRepository');
const { createLeaveHrMariaDbRepository } = require('./mariadb/leaveHrMariaDbRepository');
const { createRefreshTokenMariaDbRepository } = require('./mariadb/refreshTokenMariaDbRepository');
const { createAuthorizationMariaDbRepository } = require('./mariadb/authorizationMariaDbRepository');
const { createIdentityLinkMariaDbRepository } = require('./mariadb/identityLinkMariaDbRepository');
const { createEmployeeIdentifierMariaDbRepository } = require('./mariadb/employeeIdentifierMariaDbRepository');
const { createFacescanRawMariaDbRepository } = require('./mariadb/facescanRawMariaDbRepository');
const { createAccessTokenRevocationMariaDbRepository } = require('./mariadb/accessTokenRevocationMariaDbRepository');
const { createAttendanceHolidayMariaDbRepository } = require('./mariadb/attendanceHolidayMariaDbRepository');

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
      attendanceEvents: blockedRepo(),
      attendanceHolidays: blockedRepo(),
      leave: blockedRepo(),
      leaveHr: blockedRepo(),
      refreshTokens: blockedRepo(),
      authLogs: blockedRepo(),
      authorization: blockedRepo(),
      identityLinks: blockedRepo(),
      employeeIdentifiers: blockedRepo(),
      facescanRaw: blockedRepo(),
      accessTokenRevocations: blockedRepo(),
    };
  }

  const pool = getPool(database);
  return {
    employees: createEmployeeMariaDbRepository(pool),
    attendance: createAttendanceMariaDbRepository(pool),
    attendanceEvents: createAttendanceEventMariaDbRepository(pool),
    attendanceHolidays: createAttendanceHolidayMariaDbRepository(pool),
    leave: createLeaveMariaDbRepository(pool),
    leaveRecords: createLeaveRecordMariaDbRepository(pool),
    leaveHr: createLeaveHrMariaDbRepository(pool),
    refreshTokens: createRefreshTokenMariaDbRepository(pool),
    authLogs: createAuthLogsMariaDbRepository(pool),
    authorization: createAuthorizationMariaDbRepository(pool),
    identityLinks: createIdentityLinkMariaDbRepository(pool),
    employeeIdentifiers: createEmployeeIdentifierMariaDbRepository(pool),
    facescanRaw: createFacescanRawMariaDbRepository(pool),
    accessTokenRevocations: createAccessTokenRevocationMariaDbRepository(pool),
  };
}

module.exports = { createMariaDbRepositories, isDatabaseConfigured };
