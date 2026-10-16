const config = require('../config');
const { getDbUnavailableError, getPool, isDatabaseConfigured } = require('../db/pool');
const { createAttendanceMariaDbRepository } = require('./mariadb/attendanceMariaDbRepository');
const { createAuthLogsMariaDbRepository } = require('./mariadb/authLogsMariaDbRepository');
const { createEmployeeMariaDbRepository } = require('./mariadb/employeeMariaDbRepository');
const { createLeaveMariaDbRepository } = require('./mariadb/leaveMariaDbRepository');
const { createRefreshTokenMariaDbRepository } = require('./mariadb/refreshTokenMariaDbRepository');
const { createAuthorizationMariaDbRepository } = require('./mariadb/authorizationMariaDbRepository');
const { createIdentityLinkMariaDbRepository } = require('./mariadb/identityLinkMariaDbRepository');
const { createEmployeeIdentifierMariaDbRepository } = require('./mariadb/employeeIdentifierMariaDbRepository');
const { createEmployeeAssignmentMariaDbRepository } = require('./mariadb/employeeAssignmentMariaDbRepository');
const { createAttendanceRuleMariaDbRepository } = require('./mariadb/attendanceRuleMariaDbRepository');
const { createDailyAttendanceMariaDbRepository } = require('./mariadb/dailyAttendanceMariaDbRepository');
const { createMonthlySummaryMariaDbRepository } = require('./mariadb/monthlySummaryMariaDbRepository');
const { createFacescanIngestionMariaDbRepository } = require('./mariadb/facescanIngestionMariaDbRepository');
const { createAttendanceEventMariaDbRepository } = require('./mariadb/attendanceEventMariaDbRepository');

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
      authorization: blockedRepo(),
      identityLinks: blockedRepo(),
      employeeIdentifiers: blockedRepo(),
      employeeAssignments: blockedRepo(),
      attendanceRules: blockedRepo(),
      dailyAttendance: blockedRepo(),
      monthlySummaries: blockedRepo(),
      facescanIngestion: blockedRepo(),
      attendanceEvents: blockedRepo(),
    };
  }

  const pool = getPool(database);
  return {
    employees: createEmployeeMariaDbRepository(pool),
    attendance: createAttendanceMariaDbRepository(pool),
    leave: createLeaveMariaDbRepository(pool),
    refreshTokens: createRefreshTokenMariaDbRepository(pool),
    authLogs: createAuthLogsMariaDbRepository(pool),
    authorization: createAuthorizationMariaDbRepository(pool),
    identityLinks: createIdentityLinkMariaDbRepository(pool),
    employeeIdentifiers: createEmployeeIdentifierMariaDbRepository(pool),
    employeeAssignments: createEmployeeAssignmentMariaDbRepository(pool),
    attendanceRules: createAttendanceRuleMariaDbRepository(pool),
    dailyAttendance: createDailyAttendanceMariaDbRepository(pool),
    monthlySummaries: createMonthlySummaryMariaDbRepository(pool),
    facescanIngestion: createFacescanIngestionMariaDbRepository(pool),
    attendanceEvents: createAttendanceEventMariaDbRepository(pool),
  };
}

module.exports = { createMariaDbRepositories, isDatabaseConfigured };
