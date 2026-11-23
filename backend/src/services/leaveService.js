const { HttpError } = require('../utils/httpError');
const { assertCanReadEmployee } = require('./access');
const {
  PART_LABEL, REASON_LABEL, TYPE_LABEL, RECORD_STATUS_LABEL, SOURCE_LABEL, recordStatus,
} = require('./leaveLabels');

/** Types whose deductions we can verify from employee_leave_record / employee_leave. */
const TRACKED = ['personal', 'sick', 'vacation'];
const LEGACY_STATUS_LABEL = { approved: 'อนุมัติแล้ว', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };
const DAY_MS = 86400000;

function utcMs(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function eachDate(startDate, endDate) {
  const dates = [];
  for (let t = utcMs(startDate); t <= utcMs(endDate); t += DAY_MS) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}
const num = (value) => (value === null || value === undefined ? null : Number(value));

function recordItem(record) {
  const status = recordStatus(record);
  return {
    leaveId: record.recordUid,
    employeeUid: record.employeeUid,
    leaveType: record.leaveType,
    typeLabel: TYPE_LABEL[record.leaveType] || record.leaveType,
    startDate: record.leaveDate,
    endDate: record.leaveDate,
    status,
    statusLabel: RECORD_STATUS_LABEL[status],
    source: record.sourceSystem === 'owner_manual_entry' ? 'manual' : 'hip',
    sourceLabel: SOURCE_LABEL[record.sourceSystem] || record.sourceSystem || null,
    dayPart: record.dayPart,
    partLabel: PART_LABEL[record.dayPart] || record.dayPart,
    dayFraction: record.dayFraction,
    reasonLabels: record.reviewReason ? record.reviewReason.split(',').map((code) => REASON_LABEL[code] || code) : [],
  };
}

function legacyItem(row) {
  const status = String(row.status || '').toLowerCase();
  return {
    ...row,
    typeLabel: TYPE_LABEL[row.leaveType] || row.leaveType,
    status,
    statusLabel: LEGACY_STATUS_LABEL[status] || row.status,
    source: 'legacy',
    sourceLabel: SOURCE_LABEL.legacy,
    dayPart: null,
    partLabel: null,
    dayFraction: null,
    reasonLabels: [],
  };
}

/**
 * Personal leave list / history / balance.
 *
 * employee_leave_record (HIP-recorded and hand-entered days) is the primary source and keeps its real approval
 * status; nothing is promoted to "approved". Older employee_leave rows are shown too, except those whose every
 * day is already covered by a record of the same type (no duplicates).
 *
 * Balance: entitlement = leave_balance.total_days (verified entitlement). Used = approved days only
 * (approved records + approved legacy days not already covered by an approved record, each calendar day counted once).
 * Recorded-but-undecided, needs-review and rejected days never deduct. No entitlement row => the balance is
 * unavailable (null), never zero.
 */
function createLeaveService({ repositories }) {
  async function recordsFor(employeeUid) {
    return typeof repositories.leaveRecords?.listForEmployee === 'function'
      ? repositories.leaveRecords.listForEmployee(employeeUid) : [];
  }

  async function combined(employeeUid, year) {
    const records = await recordsFor(employeeUid);
    const legacy = await repositories.leave.list(employeeUid);
    const recordDays = new Set(records.map((r) => `${r.leaveType}|${r.leaveDate}`));
    const keptLegacy = legacy.filter((row) => !eachDate(row.startDate, row.endDate).every((d) => recordDays.has(`${row.leaveType}|${d}`)));
    const items = [...records.map(recordItem), ...keptLegacy.map(legacyItem)]
      .filter((item) => !year || (item.startDate <= `${year}-12-31` && item.endDate >= `${year}-01-01`))
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || String(a.leaveId).localeCompare(String(b.leaveId)));
    return { items, records, legacy };
  }

  return {
    async list(auth, employeeUid, query = {}) {
      const target = employeeUid || auth.employeeUid;
      await assertCanReadEmployee(auth, target, repositories, 'data');
      let year = null;
      if (query.year !== undefined && query.year !== '') {
        year = Number(query.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'VALIDATION_ERROR', 'year is invalid');
      }
      return (await combined(target, year)).items;
    },

    async history(auth, employeeUid) {
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      return (await combined(employeeUid, null)).items;
    },

    async balance(auth, employeeUid, year) {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'year is invalid');
      }
      await assertCanReadEmployee(auth, employeeUid, repositories, 'data');
      const employee = await repositories.employees.findByUid(employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      const entitlements = await repositories.leave.balance(employeeUid, year);
      const { records, legacy } = await combined(employeeUid, year);
      const inYear = (date) => date.startsWith(`${year}-`);

      const approvedDay = new Map(); // `${type}|${date}` -> days (records first; each calendar day once)
      const pendingDays = Object.fromEntries(TRACKED.map((t) => [t, 0]));
      for (const record of records.filter((r) => inYear(r.leaveDate))) {
        const status = recordStatus(record);
        if (status === 'approved') approvedDay.set(`${record.leaveType}|${record.leaveDate}`, (approvedDay.get(`${record.leaveType}|${record.leaveDate}`) || 0) + Number(record.dayFraction));
        else if (status === 'unverified' && pendingDays[record.leaveType] !== undefined) pendingDays[record.leaveType] += Number(record.dayFraction);
      }
      const recordDates = new Set(records.map((r) => `${r.leaveType}|${r.leaveDate}`));
      for (const row of legacy.filter((r) => String(r.status || '').toLowerCase() === 'approved' && (!r.matchStatus || r.matchStatus === 'matched'))) {
        for (const date of eachDate(row.startDate, row.endDate).filter(inYear)) {
          const key = `${row.leaveType}|${date}`;
          if (!recordDates.has(key)) approvedDay.set(key, 1); // a recorded day (any status) is never double counted
        }
      }
      const usedFor = (type) => [...approvedDay].filter(([key]) => key.startsWith(`${type}|`)).reduce((t, [, d]) => t + d, 0);

      const byType = new Map(entitlements.map((row) => [row.leaveType, row]));
      const types = [...new Set([...TRACKED, ...byType.keys()])];
      return types.map((leaveType) => {
        const entitlement = byType.get(leaveType) || null;
        const tracked = TRACKED.includes(leaveType);
        const totalDays = entitlement ? num(entitlement.totalDays) : null;
        const usedDays = tracked ? usedFor(leaveType) : null;
        const available = totalDays !== null && usedDays !== null;
        return {
          employeeUid,
          year,
          leaveType,
          typeLabel: TYPE_LABEL[leaveType] || leaveType,
          totalDays,
          usedDays,
          pendingDays: tracked ? pendingDays[leaveType] : null,
          remainingDays: available ? totalDays - usedDays : null,
          available,
          unavailableReason: available ? null : (totalDays === null ? 'no_entitlement' : 'deductions_not_tracked'),
        };
      });
    },
  };
}

module.exports = { createLeaveService };
