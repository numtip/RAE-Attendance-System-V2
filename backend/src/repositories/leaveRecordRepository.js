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

  async coveredPeriods() {
    return this.coverage.map((row) => row.sourcePeriod);
  }
}

module.exports = { LeaveRecordRepository };
