const { HttpError } = require('../utils/httpError');

const ROLES = Object.freeze({
  EXECUTIVE: 'EXECUTIVE',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
  ADMIN: 'ADMIN',
});

const LEGACY_ROLE = Object.freeze({
  admin: ROLES.ADMIN,
  manager: ROLES.MANAGER,
  user: ROLES.EMPLOYEE,
  executive: ROLES.EXECUTIVE,
});

function canonicalRole(role) {
  if (!role) return ROLES.EMPLOYEE;
  if (ROLES[role]) return ROLES[role];
  return LEGACY_ROLE[role] || ROLES.EMPLOYEE;
}

function emptyAuthorization() {
  return {
    async grantsFor() {
      return [];
    },
    async uidsInOrgUnits() {
      return [];
    },
  };
}

async function resolveScope(auth, repositories, domain) {
  const role = canonicalRole(auth.role);
  const authorization = repositories.authorization || emptyAuthorization();
  const grants = await authorization.grantsFor(auth.employeeUid);
  const uids = new Set([auth.employeeUid]);

  const organizationGrant = grants.some((grant) => grant.scopeType === 'organization' && grant.role === ROLES.EXECUTIVE);
  if (role === ROLES.EXECUTIVE && organizationGrant) {
    return { role, all: true, broad: true, uids };
  }

  if (domain === 'directory' && role === ROLES.ADMIN) {
    return { role, all: true, broad: false, uids };
  }

  if (role === ROLES.MANAGER) {
    const codes = grants
      .filter((grant) => grant.scopeType === 'org_unit' && grant.role === ROLES.MANAGER && grant.orgUnitCode)
      .map((grant) => grant.orgUnitCode);
    if (codes.length > 0) {
      const members = await authorization.uidsInOrgUnits(codes);
      for (const uid of members) uids.add(uid);
      return { role, all: false, broad: true, uids };
    }
  }

  return { role, all: false, broad: false, uids };
}

async function assertInScope(auth, employeeUid, repositories, domain) {
  const scope = await resolveScope(auth, repositories, domain);
  if (scope.all || scope.uids.has(employeeUid)) return scope;
  throw new HttpError(403, 'FORBIDDEN', 'This record is outside your scope');
}

module.exports = {
  ROLES,
  canonicalRole,
  emptyAuthorization,
  resolveScope,
  assertInScope,
};
