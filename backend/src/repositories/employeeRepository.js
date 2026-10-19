const { publicFields } = require('./employeeMapper');

class EmployeeRepository {
  constructor(rows) {
    this.rows = rows.map((row) => ({ ...row, loginAttempts: row.loginAttempts || 0 }));
    this.chains = new Map();
  }

  _exclusive(employeeUid, work) {
    const previous = this.chains.get(employeeUid) || Promise.resolve();
    const run = previous.then(() => work(), () => work());
    this.chains.set(employeeUid, run.then(() => undefined, () => undefined));
    return run;
  }

  async recordFailedLogin(employeeUid, { maxAttempts, lockMs, now }) {
    return this._exclusive(employeeUid, async () => {
      const row = this.rows.find((item) => item.employeeUid === employeeUid);
      if (!row) return { updated: false };
      const nowMs = now();
      if (row.lockedUntil && Date.parse(row.lockedUntil) > nowMs) {
        return { updated: false, locked: true, loginAttempts: row.loginAttempts };
      }
      if (row.lockedUntil && Date.parse(row.lockedUntil) <= nowMs) {
        row.loginAttempts = 0;
        row.lockedUntil = null;
      }
      const next = (row.loginAttempts || 0) + 1;
      await Promise.resolve();
      row.loginAttempts = next;
      if (next >= maxAttempts) {
        row.lockedUntil = new Date(nowMs + lockMs).toISOString();
      }
      return { updated: true, locked: Boolean(row.lockedUntil), loginAttempts: next };
    });
  }

  async clearLoginAttempts(employeeUid, nowMs) {
    return this._exclusive(employeeUid, async () => {
      const row = this.rows.find((item) => item.employeeUid === employeeUid);
      if (!row) return false;
      if (row.lockedUntil && Date.parse(row.lockedUntil) > nowMs) return false;
      await Promise.resolve();
      row.loginAttempts = 0;
      row.lockedUntil = null;
      return true;
    });
  }

  async findByEmail(email) {
    return this.rows.find((row) => row.email === email) || null;
  }

  async findByEmployeeId(employeeId) {
    const normalized = String(employeeId || '').trim();
    if (!normalized) return null;
    return this.rows.find((row) => row.employeeId === normalized) || null;
  }

  async findByUid(employeeUid) {
    const row = this.rows.find((item) => item.employeeUid === employeeUid);
    return row ? publicFields(row) : null;
  }

  async list() {
    return this.rows.map(publicFields);
  }
}

module.exports = { EmployeeRepository };
