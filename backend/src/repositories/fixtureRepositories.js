const fixtures = require('../dev/fixtures');
const { EmployeeRepository } = require('./employeeRepository');
const { AttendanceRepository } = require('./attendanceRepository');
const { LeaveRepository } = require('./leaveRepository');
const { createFixtureIdentityLinkRepository } = require('./fixtureIdentityLinkRepository');
const { createFixtureEmployeeIdentifierRepository } = require('./fixtureEmployeeIdentifierRepository');
const { createFixtureFacescanRawRepository } = require('./fixtureFacescanRawRepository');
const { createMemoryAccessTokenRevocationRepository } = require('./accessTokenRevocationRepository');
const { createFixtureRefreshTokenRepository } = require('./fixtureRefreshTokenRepository');

function createFixtureRepositories() {
  return {
    employees: new EmployeeRepository(fixtures.employees),
    attendance: new AttendanceRepository(fixtures.attendance, fixtures.monthly),
    leave: new LeaveRepository(fixtures.leave, fixtures.balances),
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
    },
    identityLinks: createFixtureIdentityLinkRepository(),
    employeeIdentifiers: createFixtureEmployeeIdentifierRepository(fixtures.employeeIdentifiers),
    facescanRaw: createFixtureFacescanRawRepository(),
  };
}

module.exports = { createFixtureRepositories };
