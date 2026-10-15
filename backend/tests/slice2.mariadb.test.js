/**
 * Slice 2 MariaDB integration (opt-in).
 *
 * Requires migrations 001-023 (CI's `backend-mariadb` job runs `db:migrate:seed` first). It exists to cover
 * exactly what fixture repositories cannot:
 *   * the real DDL of migrations 022/023, including the 'pending' status added to the pre-existing ENUM;
 *   * the real DATE/DATETIME shapes, i.e. that the fixture twins returning strings do not hide a mismatch;
 *   * the full chain ingest -> normalize -> calculate against a real database.
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

const TEST_PREFIX = `SLICE2-${process.pid}`;
const EMPLOYEE_UID = '22222222-2222-2222-2222-222222222222';
const WORKDAY = '2026-09-10'; // a Thursday

test('migration 022/023 DDL, real DATETIME parity, and the full calculate chain', { skip: SKIP }, async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
  const config = require('../src/config');
  const { getPool, closePool } = require('../src/db/pool');
  const { createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
  const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');
  const { createFacescanNormalizationService } = require('../src/services/facescanNormalizationService');
  const { createDailyAttendanceService } = require('../src/services/dailyAttendanceService');

  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories(config.database);
  const ingestion = createFacescanIngestionService({ repositories });
  const normalize = createFacescanNormalizationService({ repositories });
  const daily = createDailyAttendanceService({ repositories });

  const facescanId = `${TEST_PREFIX}-FS1`;
  const approvedRule = `${TEST_PREFIX}-AR-OK`;
  const pendingRule = `${TEST_PREFIX}-AR-PENDING`;
  const holidayName = `${TEST_PREFIX}-HOLIDAY`;

  t.after(async () => {
    // Order matters for the FKs: events reference staging + batches; links cascade from daily_attendance.
    await pool.query('DELETE FROM attendance_events WHERE facescan_id LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM daily_attendance_source_event');
    await pool.query('DELETE FROM daily_attendance WHERE employee_uid = ?', [EMPLOYEE_UID]);
    await pool.query('DELETE FROM staging_facescan_raw WHERE facescan_id LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM facescan_import_batches WHERE source_reference LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM employee_identifier WHERE id_value LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM attendance_schedule WHERE schedule_code LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM attendance_holiday WHERE name LIKE ?', [`${TEST_PREFIX}%`]);
    await pool.query('DELETE FROM attendance_rule_version WHERE rule_version_code LIKE ?', [`${TEST_PREFIX}%`]);
    await closePool();
  });

  await t.test('migration 023 columns and the new status value exist', async () => {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance'
         AND COLUMN_NAME IN ('source_system','rule_version_code','schedule_code','computation_status',
                             'day_classification','is_overnight','early_minutes','source_event_count',
                             'first_event_at','last_event_at','calculated_at','reconciliation_json')`,
    );
    assert.equal(cols.length, 12, 'migration 023 adds all twelve provenance columns');

    const [statusCol] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_attendance' AND COLUMN_NAME = 'status'`,
    );
    assert.match(statusCol[0].COLUMN_TYPE, /pending/, "the status ENUM carries 'pending'");

    const [rules] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('attendance_rule_version','attendance_holiday','attendance_schedule')`,
    );
    assert.equal(Number(rules[0].c), 3, 'migration 022 creates all three rule tables');
  });

  await t.test('only an approved rule is selected, and the pending one is still discoverable', async () => {
    await repositories.attendanceRules.insertRuleVersion({
      ruleVersionCode: pendingRule,
      name: 'Synthetic pending rule',
      status: 'pending_approval',
      effectiveFrom: '2026-01-01',
      workStart: '09:00:00',
      workEnd: '17:00:00',
      lateAfter: '09:00:00',
      earlyBefore: '17:00:00',
      workDays: [1, 2, 3, 4, 5],
    });
    await repositories.attendanceRules.insertRuleVersion({
      ruleVersionCode: approvedRule,
      name: 'Synthetic approved rule',
      status: 'approved',
      effectiveFrom: '2026-01-01',
      workStart: '08:30:00',
      workEnd: '16:30:00',
      lateAfter: '08:30:00',
      earlyBefore: '16:30:00',
      workDays: [1, 2, 3, 4, 5],
      approvedBy: 'operator:synthetic',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });

    const effective = await repositories.attendanceRules.findEffectiveRuleVersion(WORKDAY);
    assert.equal(effective.ruleVersionCode, approvedRule, 'the approved rule wins');
    assert.equal(effective.workStart, '08:30:00', 'TIME columns round-trip as HH:MM:SS strings');
    assert.deepEqual(effective.workDays, [1, 2, 3, 4, 5], 'the working week survives the JSON column');
    assert.equal(effective.status, 'approved');
    assert.ok(effective.approvedAt, 'the approval timestamp round-trips');

    // The approval CHECK constraint must reject an approved rule with no approver.
    await assert.rejects(
      () => repositories.attendanceRules.insertRuleVersion({
        ruleVersionCode: `${TEST_PREFIX}-AR-BAD`,
        name: 'Synthetic bad rule',
        status: 'approved',
        effectiveFrom: '2026-01-01',
        workStart: '08:30:00',
        workEnd: '16:30:00',
        lateAfter: '08:30:00',
        earlyBefore: '16:30:00',
      }),
      (error) => /RULE_INVALID_APPROVAL|APPROVAL/.test(String(error.code || error.message)),
    );
  });

  await t.test('the full chain: ingest -> normalize -> calculate, with real DATETIME values', async () => {
    await repositories.employeeIdentifiers.insert({
      employeeUid: EMPLOYEE_UID,
      idType: 'facescan_id',
      idValue: facescanId,
    });

    const batch = await ingestion.startBatch({ sourceReference: `${TEST_PREFIX}-batch` });
    await ingestion.ingestCheckinoutBatch(batch.batchUid, [
      { USERID: facescanId, CHECKTIME: `${WORKDAY} 08:45:00`, SensorID: 'G1', CHECKTYPE: 'I' },
      { USERID: facescanId, CHECKTIME: `${WORKDAY} 16:30:00`, SensorID: 'G1', CHECKTYPE: 'O' },
    ]);
    const normalized = await normalize.normalizeResolved({ importBatchUid: batch.batchUid });
    assert.equal(normalized.created, 2, 'two normalized events');

    // The parity check: mysql2 hands back a JS Date for the DATETIME column, not a string. The range query
    // and the calculation must both cope with that.
    const events = await repositories.attendanceEvents.listForEmployeeRange({
      employeeUid: EMPLOYEE_UID, from: WORKDAY, to: WORKDAY,
    });
    assert.equal(events.length, 2);
    assert.ok(events[0].eventTime instanceof Date, 'a DATETIME column reads back as a Date');

    const result = await daily.recalculateRange({ employeeUid: EMPLOYEE_UID, from: WORKDAY, to: WORKDAY });
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.calculated, 1);

    const stored = await repositories.dailyAttendance.findForEmployeeDate(EMPLOYEE_UID, WORKDAY);
    assert.equal(stored.computationStatus, 'calculated');
    assert.equal(stored.status, 'late');
    assert.equal(stored.lateMinutes, 15, '08:45 against an 08:30 threshold');
    assert.equal(stored.earlyMinutes, 0);
    assert.equal(stored.workDuration, 7.75);
    assert.equal(stored.ruleVersionCode, approvedRule);
    assert.equal(stored.dayClassification, 'workday');
    assert.equal(stored.sourceEventCount, 2);
    assert.deepEqual(stored.sourceEventIds, events.map((row) => row.id).sort((a, b) => a - b));
    // DATE and DATETIME must come back as the documented string shapes, not as Date objects.
    assert.equal(typeof stored.date, 'string');
    assert.equal(stored.date, WORKDAY);
    assert.equal(typeof stored.checkIn, 'string');
    assert.equal(stored.checkIn, `${WORKDAY} 08:45:00`);
    assert.equal(stored.checkOut, `${WORKDAY} 16:30:00`);
    assert.equal(stored.firstEventAt, `${WORKDAY} 08:45:00`);
    assert.equal(stored.reconciliationJson.ruleVersionCode, approvedRule);

    // Idempotency against a real UNIQUE key: the second run updates in place.
    await daily.recalculateRange({ employeeUid: EMPLOYEE_UID, from: WORKDAY, to: WORKDAY });
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS c FROM daily_attendance WHERE employee_uid = ? AND date = ?',
      [EMPLOYEE_UID, WORKDAY],
    );
    assert.equal(Number(countRows[0].c), 1, 'one row per employee-day');
    const [linkRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM daily_attendance_source_event l
       JOIN daily_attendance d ON d.id = l.daily_attendance_id
       WHERE d.employee_uid = ? AND d.date = ?`,
      [EMPLOYEE_UID, WORKDAY],
    );
    assert.equal(Number(linkRows[0].c), 2, 'the link set is replaced, never duplicated');
  });

  await t.test('an approved holiday is applied, and the calendar is scope-aware', async () => {
    await repositories.attendanceRules.insertHoliday({
      holidayDate: WORKDAY,
      name: holidayName,
      scope: 'university',
      status: 'approved',
      sourceSystem: 'synthetic',
      approvedBy: 'operator:synthetic',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    // A department holiday belonging to another unit must NOT be returned.
    await repositories.attendanceRules.insertHoliday({
      holidayDate: WORKDAY,
      name: `${holidayName}-OTHER-DEPT`,
      scope: 'department',
      orgUnitCode: `${TEST_PREFIX}-DEPT-X`,
      status: 'approved',
      sourceSystem: 'synthetic',
      approvedBy: 'operator:synthetic',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });

    const found = await repositories.attendanceRules.findHolidayOn(WORKDAY);
    assert.equal(found.name, holidayName, 'the university-wide holiday wins over another unit department holiday');

    const scoped = await repositories.attendanceRules.listApprovedHolidays({ from: WORKDAY, to: WORKDAY });
    const names = scoped.map((row) => row.name);
    assert.ok(names.includes(holidayName));
    assert.equal(names.includes(`${holidayName}-OTHER-DEPT`), false, 'another unit holiday is not returned');
  });

  await t.test("the real ENUM accepts 'pending', which is the migration-order check", async () => {
    // A workday with only a pending rule: the engine must record an honest `pending` row, and the OLD
    // five-value ENUM would reject it. So this test fails on a database where 023 did not fully apply.
    const pendingOnlyWorkday = '2026-09-14'; // a Monday
    const row = await repositories.dailyAttendance.upsertDay({
      employeeUid: EMPLOYEE_UID,
      date: pendingOnlyWorkday,
      checkIn: null,
      checkOut: null,
      isLate: false,
      lateMinutes: 0,
      earlyMinutes: 0,
      workDuration: 0,
      isLeave: false,
      leaveType: null,
      status: 'pending',
      notes: 'synthetic pending row',
      sourceSystem: null,
      ruleVersionCode: null,
      scheduleCode: null,
      computationStatus: 'pending_policy',
      dayClassification: 'workday',
      isOvernight: false,
      sourceEventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      calculatedAt: '2026-09-14T00:00:00.000Z',
      reconciliationJson: { reason: 'no_approved_rule' },
      sourceEventIds: [],
    });
    assert.equal(row.status, 'pending');
    assert.equal(row.computationStatus, 'pending_policy');
    assert.equal(row.reconciliationJson.reason, 'no_approved_rule');
    await pool.query('DELETE FROM daily_attendance WHERE employee_uid = ? AND date = ?', [EMPLOYEE_UID, pendingOnlyWorkday]);
  });

  await t.test('an approved schedule overrides the rule and is recorded as provenance', async () => {
    await repositories.attendanceRules.insertSchedule({
      scheduleCode: `${TEST_PREFIX}-SCH1`,
      employeeUid: EMPLOYEE_UID,
      name: 'Synthetic schedule',
      status: 'approved',
      effectiveFrom: '2026-01-01',
      workStart: '09:00:00',
      workEnd: '18:00:00',
      lateAfter: '09:00:00',
      earlyBefore: '18:00:00',
      workDays: [1, 2, 3, 4, 5],
      sourceSystem: 'synthetic',
      approvedBy: 'operator:synthetic',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });

    const schedule = await repositories.attendanceRules.findEffectiveSchedule(EMPLOYEE_UID, WORKDAY);
    assert.ok(schedule, 'the approved schedule is found');
    assert.equal(schedule.workStart, '09:00:00');
    assert.deepEqual(schedule.workDays, [1, 2, 3, 4, 5]);

    // 08:45 is late against 08:30 but NOT against the schedule's 09:00 threshold.
    await daily.recalculateRange({ employeeUid: EMPLOYEE_UID, from: WORKDAY, to: WORKDAY });
    const stored = await repositories.dailyAttendance.findForEmployeeDate(EMPLOYEE_UID, WORKDAY);
    assert.equal(stored.scheduleCode, `${TEST_PREFIX}-SCH1`);
    assert.equal(stored.isLate, false, 'the schedule threshold applies');
    assert.equal(stored.lateMinutes, 0);
  });
});
