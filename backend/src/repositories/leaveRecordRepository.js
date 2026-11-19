const { randomUUID } = require('node:crypto');

/** In-memory twin of the MariaDB repository (fixture data source and unit tests). */
class LeaveRecordRepository {
  constructor() {
    this.records = [];
    this.coverage = [];
  }

  async insertIgnore(records) {
    let inserted = 0;
    for (const record of records) {
      const exists = this.records.some((row) => row.employeeUid === record.employeeUid
        && row.leaveDate === record.leaveDate && row.dayPart === record.dayPart && row.sourceSystem === record.sourceSystem);
      if (exists) continue;
      this.records.push({ recordUid: randomUUID(), approvalStatus: 'unverified', ...record });
      inserted += 1;
    }
    return inserted;
  }

  async upsertCoverage(entry) {
    this.coverage = this.coverage.filter((row) => !(row.sourceSystem === entry.sourceSystem && row.sourcePeriod === entry.sourcePeriod));
    this.coverage.push({ ...entry });
  }

  async listBetween(start, end) {
    return this.records.filter((row) => row.leaveDate >= start && row.leaveDate <= end);
  }

  async findByUid(recordUid) {
    return this.records.find((row) => row.recordUid === recordUid) || null;
  }

  async applyDecision(recordUid, patch, audit) {
    const row = this.records.find((entry) => entry.recordUid === recordUid);
    const clash = this.records.some((entry) => entry !== row && entry.employeeUid === row.employeeUid
      && entry.leaveDate === row.leaveDate && entry.dayPart === patch.dayPart && entry.sourceSystem === row.sourceSystem);
    if (clash) return { conflict: true };
    Object.assign(row, {
      leaveType: patch.leaveType, dayPart: patch.dayPart, dayFraction: patch.dayFraction, reviewStatus: patch.reviewStatus,
      reviewReason: patch.reviewReason, approvalStatus: patch.approvalStatus, reviewedByUid: audit.actorUid, reviewNote: audit.note,
    });
    this.audit = this.audit || [];
    this.audit.push({ recordUid, ...audit });
    return { conflict: false };
  }

  async coveredPeriods() {
    return this.coverage.map((row) => row.sourcePeriod);
  }
}

module.exports = { LeaveRecordRepository };
