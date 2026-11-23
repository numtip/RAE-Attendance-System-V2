const { randomUUID } = require('node:crypto');

/**
 * In-memory twin of the MariaDB leave-HR repository (fixture data source and unit tests). It enforces the same
 * uniqueness the tables do and its `transaction` is copy-on-write: a throw leaves nothing behind.
 */
class LeaveHrRepository {
  /** @param {{ employees: { setHireDate(uid, date): Promise<boolean>, rows: object[] } }} deps the fixture employee repository */
  constructor({ employees }) {
    this.profiles = new Map();
    this.entitlements = new Map();
    this.batches = [];
    this.audit = [];
    this.employees = employees;
  }

  async getProfile(employeeUid) {
    const p = this.profiles.get(employeeUid);
    return p ? { ...p } : null;
  }

  async listProfiles(employeeUids) {
    return employeeUids.filter((u) => this.profiles.has(u)).map((u) => ({ ...this.profiles.get(u) }));
  }

  async upsertProfile(p) {
    this.profiles.set(p.employeeUid, { ...p });
  }

  _key(uid, fy, type) { return `${uid}|${fy}|${type}`; }

  async listEntitlements(employeeUid, fiscalYearBe) {
    return [...this.entitlements.values()].filter((e) => e.employeeUid === employeeUid && e.fiscalYearBe === fiscalYearBe)
      .sort((a, b) => a.leaveType.localeCompare(b.leaveType)).map((e) => ({ ...e }));
  }

  async listEntitlementsForYear(employeeUids, fiscalYearBe) {
    const set = new Set(employeeUids);
    return [...this.entitlements.values()].filter((e) => e.fiscalYearBe === fiscalYearBe && set.has(e.employeeUid)).map((e) => ({ ...e }));
  }

  async getEntitlement(employeeUid, fiscalYearBe, leaveType) {
    const e = this.entitlements.get(this._key(employeeUid, fiscalYearBe, leaveType));
    return e ? { ...e } : null;
  }

  async upsertEntitlement(e) {
    this.entitlements.set(this._key(e.employeeUid, e.fiscalYearBe, e.leaveType), { ...e });
  }

  async deleteEntitlement(employeeUid, fiscalYearBe, leaveType) {
    return this.entitlements.delete(this._key(employeeUid, fiscalYearBe, leaveType));
  }

  async findBatch(kind, fileSha256) {
    const b = this.batches.find((row) => row.kind === kind && row.fileSha256 === fileSha256);
    return b ? { ...b } : null;
  }

  async insertBatch(batch) {
    if (this.batches.some((row) => row.kind === batch.kind && row.fileSha256 === batch.fileSha256)) {
      const error = new Error('Duplicate entry');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const batchUid = batch.batchUid || randomUUID();
    this.batches.push({ ...batch, batchUid });
    return batchUid;
  }

  async appendAudit(entries) {
    for (const a of entries) this.audit.push({ ...a });
  }

  async listAudit(batchUid) {
    return this.audit.filter((a) => a.batchUid === batchUid).map(({ batchUid: _b, actorUid: _a, ...rest }) => ({ ...rest }));
  }

  async setHireDate(employeeUid, hireDate) {
    return this.employees.setHireDate(employeeUid, hireDate);
  }

  async transaction(fn) {
    const snapshot = {
      profiles: new Map([...this.profiles].map(([k, v]) => [k, { ...v }])),
      entitlements: new Map([...this.entitlements].map(([k, v]) => [k, { ...v }])),
      batches: this.batches.map((b) => ({ ...b })),
      audit: this.audit.map((a) => ({ ...a })),
      hireDates: new Map(this.employees.rows.map((r) => [r.employeeUid, r.hireDate])),
    };
    try {
      return await fn(this);
    } catch (error) {
      const { hireDates, ...own } = snapshot;
      Object.assign(this, own);
      for (const row of this.employees.rows) row.hireDate = hireDates.get(row.employeeUid);
      throw error;
    }
  }
}

module.exports = { LeaveHrRepository };
