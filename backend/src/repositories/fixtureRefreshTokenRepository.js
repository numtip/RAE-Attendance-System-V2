const { randomUUID } = require('node:crypto');
const { hashRefreshToken } = require('../security/refreshTokenHash');

function createFixtureRefreshTokenRepository() {
  const rows = [];
  const chains = new Map();

  function exclusive(key, work) {
    const previous = chains.get(key) || Promise.resolve();
    const run = previous.then(() => work(), () => work());
    chains.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  function locate(raw) {
    const hash = hashRefreshToken(raw);
    return rows.find((row) => row.tokenHash === hash)
      || rows.find((row) => row.tokenHash == null && row.legacyToken === raw)
      || null;
  }

  function view(row) {
    if (!row) return null;
    return {
      id: row.id,
      employeeUid: row.employeeUid,
      role: row.role,
      email: row.email,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      familyId: row.familyId,
    };
  }

  function revokeFamily(row, now) {
    if (!row.familyId) {
      if (!row.revokedAt) row.revokedAt = now;
      return;
    }
    for (const item of rows) {
      if (item.familyId === row.familyId && !item.revokedAt) item.revokedAt = now;
    }
  }

  return {
    async save(record) {
      const row = {
        id: randomUUID(),
        employeeUid: record.employeeUid,
        role: record.role,
        email: record.email,
        expiresAt: record.expiresAt,
        revokedAt: null,
        familyId: record.familyId || randomUUID(),
        tokenHash: hashRefreshToken(record.token),
        legacyToken: null,
      };
      rows.push(row);
      return row.id;
    },

    async find(raw) {
      return view(locate(raw));
    },

    async revoke(raw) {
      const row = locate(raw);
      if (!row) return false;
      revokeFamily(row, new Date().toISOString());
      return true;
    },

    async rotate(raw) {
      const key = hashRefreshToken(raw);
      return exclusive(key, async () => {
        const row = locate(raw);
        if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return { outcome: 'invalid' };
        if (row.revokedAt) {
          revokeFamily(row, new Date().toISOString());
          return { outcome: 'reused' };
        }
        const familyId = row.familyId || randomUUID();
        row.familyId = familyId;
        row.revokedAt = new Date().toISOString();
        const successor = randomUUID();
        rows.push({
          id: randomUUID(),
          employeeUid: row.employeeUid,
          role: row.role,
          email: row.email,
          expiresAt: row.expiresAt,
          revokedAt: null,
          familyId,
          tokenHash: hashRefreshToken(successor),
          legacyToken: null,
        });
        return {
          outcome: 'rotated',
          refreshToken: successor,
          employeeUid: row.employeeUid,
          role: row.role,
          email: row.email,
          expiresAt: row.expiresAt,
        };
      });
    },
  };
}

module.exports = { createFixtureRefreshTokenRepository };
