/**
 * In-memory twin of the monthly_summary WRITE repository.
 *
 * STRING-SHAPE CONTRACT (same as the MariaDB twin): every method returns the SAME JSON shape regardless of
 * storage. In particular `ruleVersions` is always an **array** and `dayCounts` always an **object** — the
 * MariaDB twin serializes them into the JSON columns on write and parses them back on read, so a caller
 * never has to know which backend it is talking to. `calculatedAt` is always an ISO string or null, and the
 * `total*` fields are always numbers.
 *
 * See backend/src/utils/bangkokTime.js `wallDateOnly` for the precedent: the twins diverging on the SHAPE of
 * a value (a Date where a string was expected) has broken two consecutive slices, so the shape is fixed
 * here explicitly.
 */
const { HttpError } = require('../utils/httpError');
const {
  MONTH_COMPUTATION_STATUS,
  assertPeriod,
} = require('../domain/monthlyAttendanceCalculation');

function requireNonNegativeInteger(value, code) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new HttpError(400, code, 'value must be a non-negative integer');
  }
  return num;
}

function requireFiniteNumber(value, code) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new HttpError(400, code, 'value must be a finite number greater than or equal to zero');
  }
  return num;
}

function normalizeMonthInput(input) {
  const source = input || {};
  if (!source.employeeUid || typeof source.employeeUid !== 'string') {
    throw new HttpError(400, 'MONTHLY_INVALID_EMPLOYEE', 'employeeUid is required');
  }
  const year = Number(source.year);
  const month = Number(source.month);
  assertPeriod(year, month);

  const computationStatus = String(source.computationStatus ?? '');
  if (!MONTH_COMPUTATION_STATUS.includes(computationStatus)) {
    throw new HttpError(400, 'MONTHLY_INVALID_STATUS', 'computationStatus is not a supported value');
  }

  // nullable on purpose: NULL means "could not be derived", which is not the same as 0.
  let expectedWorkingDays = null;
  if (source.expectedWorkingDays !== undefined && source.expectedWorkingDays !== null) {
    expectedWorkingDays = requireNonNegativeInteger(source.expectedWorkingDays, 'MONTHLY_INVALID_COUNT');
  }

  const ruleVersions = Array.isArray(source.ruleVersions)
    ? Array.from(new Set(source.ruleVersions.map((code) => String(code)))).sort()
    : [];
  const dayCounts = source.dayCounts && typeof source.dayCounts === 'object' ? source.dayCounts : {};

  return {
    employeeUid: source.employeeUid,
    year,
    month,
    totalWorkDays: requireNonNegativeInteger(source.totalWorkDays, 'MONTHLY_INVALID_COUNT'),
    totalPresent: requireNonNegativeInteger(source.totalPresent, 'MONTHLY_INVALID_COUNT'),
    totalLate: requireNonNegativeInteger(source.totalLate, 'MONTHLY_INVALID_COUNT'),
    totalAbsent: requireNonNegativeInteger(source.totalAbsent, 'MONTHLY_INVALID_COUNT'),
    totalLeave: requireNonNegativeInteger(source.totalLeave, 'MONTHLY_INVALID_COUNT'),
    totalLateMinutes: requireNonNegativeInteger(source.totalLateMinutes, 'MONTHLY_INVALID_COUNT'),
    totalEarlyMinutes: requireNonNegativeInteger(source.totalEarlyMinutes ?? 0, 'MONTHLY_INVALID_COUNT'),
    pendingDays: requireNonNegativeInteger(source.pendingDays ?? 0, 'MONTHLY_INVALID_COUNT'),
    holidayDays: requireNonNegativeInteger(source.holidayDays ?? 0, 'MONTHLY_INVALID_COUNT'),
    totalWorkHours: requireFiniteNumber(source.totalWorkHours, 'MONTHLY_INVALID_DURATION'),
    expectedWorkingDays,
    computationStatus,
    ruleVersions,
    dayCounts,
    derivationNotes: source.derivationNotes == null ? null : String(source.derivationNotes),
    calculatedAt: source.calculatedAt == null ? null : String(source.calculatedAt),
    sourceKind: source.sourceKind == null ? 'derived_from_daily_attendance' : String(source.sourceKind),
  };
}

function mapRecord(record) {
  return {
    id: record.id,
    employeeUid: record.employeeUid,
    year: record.year,
    month: record.month,
    totalWorkDays: record.totalWorkDays,
    totalPresent: record.totalPresent,
    totalLate: record.totalLate,
    totalAbsent: record.totalAbsent,
    totalLeave: record.totalLeave,
    totalLateMinutes: record.totalLateMinutes,
    totalEarlyMinutes: record.totalEarlyMinutes,
    pendingDays: record.pendingDays,
    holidayDays: record.holidayDays,
    totalWorkHours: record.totalWorkHours,
    expectedWorkingDays: record.expectedWorkingDays,
    computationStatus: record.computationStatus,
    ruleVersions: Array.isArray(record.ruleVersions) ? [...record.ruleVersions] : [],
    dayCounts: record.dayCounts && typeof record.dayCounts === 'object' ? { ...record.dayCounts } : {},
    derivationNotes: record.derivationNotes,
    calculatedAt: record.calculatedAt,
    sourceKind: record.sourceKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * @param {Array} initialRows rows in the same shape `mapRecord` returns. Used by the fixture container and
 *                           by tests. `{ employeeExists }` mirrors the FK so a bad employee fails the same
 *                           way it would in MariaDB.
 */
function createFixtureMonthlySummaryRepository(initialRows = [], { employeeExists = null } = {}) {
  let nextId = 1;
  const rows = [];
  const byKey = new Map();
  const keyOf = (employeeUid, year, month) => `${employeeUid}|${year}|${month}`;

  for (const row of initialRows) {
    const seeded = mapRecord({
      pendingDays: 0,
      holidayDays: 0,
      totalEarlyMinutes: 0,
      expectedWorkingDays: null,
      computationStatus: 'calculated',
      ruleVersions: [],
      dayCounts: {},
      derivationNotes: null,
      calculatedAt: null,
      sourceKind: 'seed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...row,
      id: row.id ?? nextId++,
    });
    rows.push(seeded);
    byKey.set(keyOf(seeded.employeeUid, seeded.year, seeded.month), seeded);
  }

  return {
    /** Idempotent on (employee_uid, year, month): a re-derivation replaces the row in place. */
    async upsertMonth(input) {
      const normalized = normalizeMonthInput(input);
      if (employeeExists && !employeeExists(normalized.employeeUid)) {
        throw new HttpError(404, 'MONTHLY_UNKNOWN_EMPLOYEE', 'Employee was not found');
      }
      const key = keyOf(normalized.employeeUid, normalized.year, normalized.month);
      const now = new Date().toISOString();
      const existing = byKey.get(key);
      if (existing) {
        // `createdAt` is preserved; every derived field is replaced.
        Object.assign(existing, normalized, { updatedAt: now });
        return mapRecord(existing);
      }
      const record = mapRecord({ ...normalized, id: nextId++, createdAt: now, updatedAt: now });
      rows.push(record);
      byKey.set(key, record);
      return mapRecord(record);
    },

    async findForEmployeeMonth(employeeUid, year, month) {
      const parsedYear = Number(year);
      const parsedMonth = Number(month);
      if (!employeeUid || !Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth)) return null;
      const found = byKey.get(keyOf(employeeUid, parsedYear, parsedMonth));
      return found ? mapRecord(found) : null;
    },

    async listForEmployeeYear(employeeUid, year) {
      const parsedYear = Number(year);
      if (!employeeUid || !Number.isInteger(parsedYear)) return [];
      return rows
        .filter((row) => row.employeeUid === employeeUid && row.year === parsedYear)
        .sort((a, b) => a.month - b.month)
        .map(mapRecord);
    },

    /** Test hook: a copy of every stored row. */
    all() {
      return rows.map(mapRecord);
    },
  };
}

module.exports = { createFixtureMonthlySummaryRepository, normalizeMonthInput };
