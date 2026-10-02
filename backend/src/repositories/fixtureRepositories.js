const { randomUUID } = require('node:crypto');
const fixtures = require('../dev/fixtures');
const { EmployeeRepository } = require('./employeeRepository');
const { AttendanceRepository } = require('./attendanceRepository');
const { LeaveRepository } = require('./leaveRepository');
const { createFixtureIdentityLinkRepository } = require('./fixtureIdentityLinkRepository');
const { createFixtureEmployeeIdentifierRepository } = require('./fixtureEmployeeIdentifierRepository');
const { createFixtureFacescanRawRepository } = require('./fixtureFacescanRawRepository');

function createFixtureRepositories() {
  const refreshTokens = new Map();
  return {
    employees: new EmployeeRepository(fixtures.employees),
    attendance: new AttendanceRepository(fixtures.attendance, fixtures.monthly),
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
    employeeIdentifiers: createFixtureEmployeeIdentifierRepository(fixtures.employeeIdentifiers),
    facescanRaw: createFixtureFacescanRawRepository(),
  };
}

module.exports = { createFixtureRepositories };
