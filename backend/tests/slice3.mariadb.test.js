/**
 * Slice 3 MariaDB integration (opt-in).
 *
 * Requires migrations 001-024 (CI's `backend-mariadb` job runs `db:migrate:seed` first). It covers what the
 * fixture twins cannot: the real DDL of migration 024, the JSON columns round-tripping, NULL staying NULL,
 * real idempotency against the unique key, and the derived month end to end.
 *
 * It deliberately does NOT create attendance_events: a daily row is written straight through the repository
 * with no source events, which keeps the FK chain out of the fixture setup. (A previous slice's CI failure
 * came from deleting attendance_events before the link rows that referenced them.)
 *
 * Local run: RUN_MARIADB_TESTS=1 + DB_* against a THROW-AWAY database. Never point this at production.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { isDatabaseConfigured } = require('../src/repositories/mariadbRepositories');

function shouldRunMariaDbIntegration() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const SKIP = !shouldRunMariaDbIntegration();

const TEST_PREFIX = `SLICE3-${process.pid}`;
const EMPLOYEE_UID = '22222222-2222-2222-2222-222222222222';
// A far-future period, deliberately. CI runs test FILES IN PARALLEL against one database, so any rule
// another suite leaves open-ended would cover a nearby date and break the "no approved rule" assertion.
// Nothing else targets 2031, and the suites that touch 2026 are bounded to their own month.
const YEAR = 2031;
const MONTH = 11;
const RULE_CODE = `${TEST_PREFIX}-AR`;

/** Independently computed expected values, so the assertion does not re-derive them with the module under test. */
function weekdaysInMonth(year, month) {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = 1; day <= total; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun .. 6=Sat
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}

/** The first Monday of the month, so the approved Mon-Fri week makes it a working day. */
function firstMondayOf(year, month) {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= total; day += 1) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  throw new Error('no Monday found in the month');
}

const MONDAY = firstMondayOf(YEAR, MONTH);
const EXPECTED_WORKING_DAYS = weekdaysInMonth(YEAR, MONTH);

test('migration 024 DDL, real JSON/NULL shapes, and the derived month', { skip: SKIP }, async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
  const config = require('../src/config');
  const { getPool, closePool } = require('../src/db/pool');
  const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
  const { createMonthlySummaryService } = require('../src/services/monthlySummaryService');

  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories(config.database);
  const service = createMonthlySummaryService({ repositories });
  // The caller owns the record, so the scope check passes; the role permits a derivation.
  const auth = { employeeUid: EMPLOYEE_UID, role: 'admin' };

  async function seedDailyRow(date, overrides = {}) {
    return repositories.dailyAttendance.upsertDay({
      employeeUid: EMPLOYEE_UID,
      date,
      checkIn: `${date} 08:45:00`,
      checkOut: `${date} 16:30:00`,
      isLate: true,
      lateMinutes: 15,
      earlyMinutes: 0,
      workDuration: 7.75,
      isLeave: false,
      leaveType: null,
      status: 'late',
      notes: null,
      sourceSystem: 'hip_pm2014',
      ruleVersionCode: RULE_CODE,
      scheduleCode: null,
      computationStatus: 'calculated',
      dayClassification: 'workday',
      isOvernight: false,
      sourceEventCount: 2,
      firstEventAt: `${date} 08:45:00`,
      lastEventAt: `${date} 16:30:00`,
      calculatedAt: `${date} 23:00:00`,
      reconciliationJson: { reason: 'synthetic_slice3' },
      sourceEventIds: [],
      ...overrides,
    });
  }

  t.after(async () => {
    // Monthly first (no FK, but keep the intent obvious), then daily (its source-event links cascade away).
    await pool.query('DELETE FROM monthly_summary WHERE employee_uid = ? AND year = ?', [EMPLOYEE_UID, YEAR]);
    await pool.query('DELETE FROM daily_attendance WHERE employee_uid = ? AND date BETWEEN ? AND ?', [
      EMPLOYEE_UID, `${YEAR}-11-01`, `${YEAR}-11-30`,
    ]);    await pool.query('DELETE FROM attendance_rule_version WHERE rule_version_code = ?', [RULE_CODE]);
    await closePool();
  });

  await t.test('migration 024 columns, indexes and the widened ENUM exist', async () => {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
         AND COLUMN_NAME IN ('computation_status','rule_versions_json','expected_working_days','pending_days',
                             'holiday_days','total_early_minutes','day_counts_json','derivation_notes',
                             'calculated_at','source_kind')`,
    );
    assert.equal(cols.length, 10, 'migration 024 adds all ten provenance columns');

    const [statusCol] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary' AND COLUMN_NAME = 'computation_status'`,
    );
    assert.match(statusCol[0].COLUMN_TYPE, /partial/, "the status ENUM carries 'partial'");
    assert.match(statusCol[0].COLUMN_TYPE, /pending_policy/, "and 'pending_policy'");

    const [idx] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
         AND INDEX_NAME = 'uk_monthly_summary_employee_period'`,
    );
    assert.ok(idx.length > 0, 'the unique key on (employee_uid, year, month) exists');

    const [expectedCol] = await pool.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monthly_summary'
         AND COLUMN_NAME = 'expected_working_days'`,
    );
    assert.equal(expectedCol[0].IS_NULLABLE, 'YES', 'expected_working_days must stay nullable');
  });

  await t.test('an approved rule is required before a month can be judged', async () => {
    await seedDailyRow(MONDAY);

    // No approved rule covers 2031, so the month is pending_policy with nothing derived from policy.
    const pending = await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(pending.stored.computationStatus, 'pending_policy');
    assert.equal(pending.stored.expectedWorkingDays, null, 'NULL, not 0, when it cannot be derived');
    assert.match(pending.stored.derivationNotes, /no_approved_rule/);

    // Now approve a rule for the period and re-derive.
    await repositories.attendanceRules.insertRuleVersion({
      ruleVersionCode: RULE_CODE,
      name: 'Synthetic Slice 3 approved rule',
      status: 'approved',
      effectiveFrom: `${YEAR}-01-01`,
      effectiveTo: `${YEAR}-12-31`,
      workStart: '08:30:00',
      workEnd: '16:30:00',
      lateAfter: '08:30:00',
      earlyBefore: '16:30:00',
      workDays: [1, 2, 3, 4, 5],
      approvedBy: 'operator:synthetic',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });

    const derived = await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(derived.stored.computationStatus, 'calculated');
    assert.equal(
      derived.stored.expectedWorkingDays,
      EXPECTED_WORKING_DAYS,
      'the approved Mon-Fri calendar, counted independently of the module under test',
    );
    assert.equal(derived.stored.totalLate, 1);
    assert.equal(derived.stored.totalLateMinutes, 15);
    assert.equal(derived.stored.totalWorkHours, 7.75);
    assert.deepEqual(derived.stored.ruleVersions, [RULE_CODE], 'a JSON column read back as an array');
    assert.equal(Array.isArray(derived.stored.ruleVersions), true);
    assert.equal(typeof derived.stored.dayCounts, 'object');
    assert.equal(derived.stored.dayCounts.rows, 1);

    // String-shape contract: the twins must agree on the TYPE of every field.
    assert.equal(typeof derived.stored.calculatedAt, 'string', 'calculatedAt is an ISO string, not a Date');
    assert.equal(Number.isNaN(Date.parse(derived.stored.calculatedAt)), false);
    assert.equal(typeof derived.stored.totalWorkHours, 'number');
    assert.equal(typeof derived.stored.expectedWorkingDays, 'number');
    assert.equal(typeof derived.stored.sourceKind, 'string');
  });

  await t.test('the upsert is idempotent against the real unique key', async () => {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS c FROM monthly_summary WHERE employee_uid = ? AND year = ? AND month = ?',
      [EMPLOYEE_UID, YEAR, MONTH],
    );
    assert.equal(Number(rows[0].c), 1, 'exactly one row per employee-month');

    const before = await repositories.monthlySummaries.findForEmployeeMonth(EMPLOYEE_UID, YEAR, MONTH);
    await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    const [again] = await pool.query(
      'SELECT COUNT(*) AS c FROM monthly_summary WHERE employee_uid = ? AND year = ? AND month = ?',
      [EMPLOYEE_UID, YEAR, MONTH],
    );
    assert.equal(Number(again[0].c), 1, 're-derivation updates in place');

    const after = await repositories.monthlySummaries.findForEmployeeMonth(EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(after.totalLate, before.totalLate);
    assert.equal(after.computationStatus, before.computationStatus);
    assert.equal(after.id, before.id, 'the same row, not a replacement');
  });

  await t.test('a partial month is stored as partial, with the unjudged day counted', async () => {
    await seedDailyRow(`${YEAR}-11-03`, {
      status: 'pending',
      computationStatus: 'insufficient_data',
      checkIn: `${YEAR}-11-03 08:45:00`,
      checkOut: `${YEAR}-11-03 08:45:00`,
      isLate: false,
      lateMinutes: 0,
      workDuration: 0,
      ruleVersionCode: null,
      sourceEventCount: 1,
    });

    const result = await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(result.stored.computationStatus, 'partial');
    assert.equal(result.stored.pendingDays, 1);
    assert.equal(result.stored.dayCounts.unjudgedDays, 1);
  });

  await t.test('explain reports staleness from the derived values', async () => {
    await service.recalculateMonth(auth, EMPLOYEE_UID, YEAR, MONTH);
    const fresh = await service.explain(auth, EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(fresh.stale, false, 'a freshly derived month is not stale');

    // Change a day, and the stored month no longer matches the data.
    await seedDailyRow(`${YEAR}-11-04`, { lateMinutes: 45, status: 'late' });
    const changed = await service.explain(auth, EMPLOYEE_UID, YEAR, MONTH);
    assert.equal(changed.stale, true);
    assert.ok(changed.staleReasons.includes('derived_values_differ'));
  });

  await t.test('a month with no daily rows and no stored row is not inserted', async () => {
    const [before] = await pool.query(
      'SELECT COUNT(*) AS c FROM monthly_summary WHERE employee_uid = ? AND year = ?',
      [EMPLOYEE_UID, YEAR],
    );
    await service.recalculate(auth, { employeeUid: EMPLOYEE_UID, year: YEAR, month: 12 });
    const [after] = await pool.query(
      'SELECT COUNT(*) AS c FROM monthly_summary WHERE employee_uid = ? AND year = ?',
      [EMPLOYEE_UID, YEAR],
    );
    assert.equal(Number(after[0].c), Number(before[0].c), 'no phantom zero-month row for December');
  });
});
