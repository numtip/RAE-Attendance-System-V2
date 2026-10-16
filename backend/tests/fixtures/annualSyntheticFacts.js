/**
 * Synthetic facts for the R-05 annual report suite.
 *
 * EVERY value here is invented for the test. Nothing is copied from `G:\ProjectAI\attendance-report-generator`
 * (private, read-only) and no real personnel value, roster or national id is present. The month rows are
 * written through the SAME repository contract the production code writes through (`upsertMonth`), so a
 * test cannot assert against a shape the service would never see.
 *
 * The per-month values are deliberately DIFFERENT for every month, so an annual total that merely copied
 * one month (or multiplied a single month by twelve) would fail the assertions.
 *
 * Fiscal years chosen here are entirely in the past relative to the suite's injected clock
 * (2026-10-16), so they are closed periods and every month has started.
 */
const { fiscalYearPeriod } = require('../../src/domain/reconciliationPeriod');

const USER_UID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

/** 1 Oct 2024 .. 30 Sep 2025 — a closed fiscal year that does not overlap the fixture's seeded 2026-03. */
const CLOSED_FISCAL_YEAR = 2568;

/** The synthetic clock the suite injects, so the window maths is deterministic. */
const FIXED_NOW = () => new Date('2026-10-16T04:16:45.000Z');

/** A month row whose every metric differs by month index, so only a real sum can satisfy the assertions. */
function monthValues(index) {
  return {
    totalWorkDays: 20 + index,
    totalPresent: 10 + index,
    totalLate: index % 3,
    totalAbsent: 1 + (index % 2),
    totalLeave: index % 2,
    totalLateMinutes: 5 * (index + 1),
    totalEarlyMinutes: index,
    totalWorkHours: 8 * (index + 1),
    expectedWorkingDays: 20 + index,
    pendingDays: 0,
    holidayDays: index % 2,
  };
}

/** Write one synthetic derived month through the real write contract. */
async function seedMonthRow(repositories, {
  employeeUid, year, month, values, computationStatus = 'calculated', ruleVersions = ['AR-SYNTHETIC'],
}) {
  return repositories.monthlySummaries.upsertMonth({
    employeeUid,
    year,
    month,
    ...values,
    computationStatus,
    ruleVersions,
    dayCounts: { rows: 22, unjudgedDays: computationStatus === 'calculated' ? 0 : 1 },
    derivationNotes: null,
    calculatedAt: '2025-10-01T00:00:00.000Z',
  });
}

/**
 * Every month of a closed fiscal year, all judged. Returns the seeded month list so a test can build its
 * own expectation from the same facts the service reads.
 */
async function seedCompleteFiscalYear(repositories, {
  fiscalYear = CLOSED_FISCAL_YEAR, employeeUid = USER_UID,
} = {}) {
  const period = fiscalYearPeriod(fiscalYear);
  const seeded = [];
  for (let index = 0; index < period.months.length; index += 1) {
    const entry = period.months[index];
    const values = monthValues(index);
    await seedMonthRow(repositories, { employeeUid, year: entry.year, month: entry.month, values });
    seeded.push({ key: `${entry.year}-${String(entry.month).padStart(2, '0')}`, ...entry, values });
  }
  return { period, seeded };
}

/** Every month except one, so exactly one month was never derived. */
async function seedFiscalYearMissingMonth(repositories, {
  fiscalYear = CLOSED_FISCAL_YEAR, employeeUid = USER_UID, missingMonth = 4,
} = {}) {
  const period = fiscalYearPeriod(fiscalYear);
  const seeded = [];
  for (let index = 0; index < period.months.length; index += 1) {
    const entry = period.months[index];
    if (entry.month === missingMonth) continue;
    const values = monthValues(index);
    await seedMonthRow(repositories, { employeeUid, year: entry.year, month: entry.month, values });
    seeded.push({ key: `${entry.year}-${String(entry.month).padStart(2, '0')}`, ...entry, values });
  }
  const missingEntry = period.months.find((entry) => entry.month === missingMonth);
  return {
    period,
    seeded,
    missing: { key: `${missingEntry.year}-${String(missingEntry.month).padStart(2, '0')}`, ...missingEntry },
  };
}

/** Every month derived, but one is NOT judged, so the year cannot be final. */
async function seedFiscalYearUnjudgedMonth(repositories, {
  fiscalYear = CLOSED_FISCAL_YEAR,
  employeeUid = USER_UID,
  unjudgedMonth = 12,
  status = 'partial',
} = {}) {
  const period = fiscalYearPeriod(fiscalYear);
  const seeded = [];
  for (let index = 0; index < period.months.length; index += 1) {
    const entry = period.months[index];
    const values = monthValues(index);
    const computationStatus = entry.month === unjudgedMonth ? status : 'calculated';
    await seedMonthRow(repositories, {
      employeeUid, year: entry.year, month: entry.month, values, computationStatus,
    });
    seeded.push({ key: `${entry.year}-${String(entry.month).padStart(2, '0')}`, ...entry, computationStatus });
  }
  return { period, seeded };
}

/**
 * A synthetic "the employee code changed hands" case, the precedent the reference project states in its own
 * `site/index.html`: months where the code's holder changed are NOT summed together.
 *
 * Two DIFFERENT employees (two `employee_uid`s, which is how V2 keys attendance) each hold part of the same
 * fiscal year, as a code reused mid-year would look. `splitAt` is the number of months the FIRST holder has.
 */
async function seedSplitOwnershipYear(repositories, {
  fiscalYear = CLOSED_FISCAL_YEAR, splitAt = 5,
} = {}) {
  const period = fiscalYearPeriod(fiscalYear);
  const first = [];
  const second = [];
  for (let index = 0; index < period.months.length; index += 1) {
    const entry = period.months[index];
    const values = monthValues(index);
    const holder = index < splitAt ? USER_UID : ADMIN_UID;
    await seedMonthRow(repositories, { employeeUid: holder, year: entry.year, month: entry.month, values });
    const key = `${entry.year}-${String(entry.month).padStart(2, '0')}`;
    (index < splitAt ? first : second).push({ key, ...entry, values });
  }
  return { period, first, second };
}

/**
 * A stubbed `employee_assignment` history: one employee whose OWN code changed mid-period. Used to prove the
 * provenance block records the change (it cannot prove anything about ANOTHER holder — see the service).
 */
function stubAssignmentHistory(repositories, employeeUid, windows) {
  repositories.employeeAssignments.listByEmployeeUid = async (uid) => (
    uid === employeeUid ? windows.map((row) => ({ ...row })) : []
  );
}

module.exports = {
  USER_UID,
  ADMIN_UID,
  CLOSED_FISCAL_YEAR,
  FIXED_NOW,
  monthValues,
  seedMonthRow,
  seedCompleteFiscalYear,
  seedFiscalYearMissingMonth,
  seedFiscalYearUnjudgedMonth,
  seedSplitOwnershipYear,
  stubAssignmentHistory,
};
