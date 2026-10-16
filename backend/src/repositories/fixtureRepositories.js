const { randomUUID } = require('node:crypto');
const fixtures = require('../dev/fixtures');
const { EmployeeRepository } = require('./employeeRepository');
const { AttendanceRepository } = require('./attendanceRepository');
const { LeaveRepository } = require('./leaveRepository');
const { createFixtureIdentityLinkRepository } = require('./fixtureIdentityLinkRepository');
const { createFixtureEmployeeIdentifierRepository } = require('./fixtureEmployeeIdentifierRepository');
const { createFixtureEmployeeAssignmentRepository } = require('./fixtureEmployeeAssignmentRepository');
const { createFixtureAttendanceRuleRepository } = require('./fixtureAttendanceRuleRepository');
const { createFixtureDailyAttendanceRepository } = require('./fixtureDailyAttendanceRepository');
const { createFixtureMonthlySummaryRepository } = require('./fixtureMonthlySummaryRepository');
const { createFixtureFacescanIngestionRepository } = require('./fixtureFacescanIngestionRepository');
const { createFixtureAttendanceEventRepository } = require('./fixtureAttendanceEventRepository');

function createFixtureRepositories({ nationalId = null, identifiers = null } = {}) {
  const refreshTokens = new Map();
  const employeeExists = (employeeUid) => fixtures.employees.some((row) => row.employeeUid === employeeUid);
  // One store for the month, read by BOTH the legacy /attendance/monthly route and the Slice 3 derived
  // endpoints, so fixture mode cannot show two different versions of the same month.
  const monthlySummaries = createFixtureMonthlySummaryRepository(fixtures.monthly, { employeeExists });
  return {
    employees: new EmployeeRepository(fixtures.employees),
    attendance: new AttendanceRepository(fixtures.attendance, fixtures.monthly, monthlySummaries),
    leave: new LeaveRepository(fixtures.leave, fixtures.balances),
    refreshTokens: {
      async save(record) {
        const id = randomUUID();
        refreshTokens.set(record.token, { ...record, id });
        return id;
      },
      async find(token) {
        return refreshTokens.get(token) || null;
      },
      async revoke(token) {
        const row = refreshTokens.get(token);
        if (!row || row.revokedAt) return false;
        row.revokedAt = new Date().toISOString();
        return true;
      },
    },
    authLogs: {
      async append() {},
    },
    authorization: {
      async grantsFor(employeeUid) {
        return fixtures.authorizationGrants.filter((grant) => grant.employeeUid === employeeUid);
      },
      async uidsInOrgUnits(orgUnitCodes) {
        const codes = new Set(orgUnitCodes);
        return fixtures.orgMemberships
          .filter((row) => codes.has(row.orgUnitCode))
          .map((row) => row.employeeUid);
      },
    },
    identityLinks: createFixtureIdentityLinkRepository(),
    employeeIdentifiers: createFixtureEmployeeIdentifierRepository(identifiers || fixtures.employeeIdentifiers, { nationalId }),
    employeeAssignments: createFixtureEmployeeAssignmentRepository(fixtures.employeeAssignments, {
      employeeExists,
    }),
    attendanceRules: createFixtureAttendanceRuleRepository({
      ruleVersions: fixtures.attendanceRuleVersions,
      holidays: fixtures.attendanceHolidays,
      schedules: fixtures.attendanceSchedules,
    }, {
      // Mirrors the FK on attendance_schedule, so the fixture twin fails like MariaDB does.
      employeeExists,
    }),
    dailyAttendance: createFixtureDailyAttendanceRepository(fixtures.dailyAttendance),
    monthlySummaries,
    facescanIngestion: createFixtureFacescanIngestionRepository(),
    attendanceEvents: createFixtureAttendanceEventRepository(),
  };
}

module.exports = { createFixtureRepositories };
