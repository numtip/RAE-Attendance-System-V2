const fixtures = require('../dev/fixtures');
const { EmployeeRepository } = require('./employeeRepository');
const { AttendanceRepository } = require('./attendanceRepository');
const { createAttendanceEventRepository } = require('./attendanceEventRepository');
const { LeaveRepository } = require('./leaveRepository');
const { LeaveRecordRepository } = require('./leaveRecordRepository');
const { createFixtureIdentityLinkRepository } = require('./fixtureIdentityLinkRepository');
const { createFixtureEmployeeIdentifierRepository } = require('./fixtureEmployeeIdentifierRepository');
const { createFixtureFacescanRawRepository } = require('./fixtureFacescanRawRepository');
const { createMemoryAccessTokenRevocationRepository } = require('./accessTokenRevocationRepository');
const { createFixtureRefreshTokenRepository } = require('./fixtureRefreshTokenRepository');

function createFixtureRepositories() {
  return {
    employees: new EmployeeRepository(fixtures.employees),
    attendance: new AttendanceRepository(fixtures.attendance, fixtures.monthly),
    attendanceEvents: createAttendanceEventRepository(fixtures.attendanceEvents || []),
    leave: new LeaveRepository(fixtures.leave, fixtures.balances),
    leaveRecords: new LeaveRecordRepository(),
    refreshTokens: createFixtureRefreshTokenRepository(),
    authLogs: {
      async append() {},
    },
    accessTokenRevocations: createMemoryAccessTokenRevocationRepository(),
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
      async addMembership(employeeUid, orgUnitCode) {
        if (fixtures.orgMemberships.some((row) => row.employeeUid === employeeUid && row.orgUnitCode === orgUnitCode)) return false;
        fixtures.orgMemberships.push({ employeeUid, orgUnitCode });
        return true;
      },
      async listMemberships() {
        return fixtures.orgMemberships.map((row) => ({ employeeUid: row.employeeUid, orgUnitCode: row.orgUnitCode }));
      },
    },
    identityLinks: createFixtureIdentityLinkRepository(),
    employeeIdentifiers: createFixtureEmployeeIdentifierRepository(fixtures.employeeIdentifiers),
    facescanRaw: createFixtureFacescanRawRepository(),
  };
}

module.exports = { createFixtureRepositories };
