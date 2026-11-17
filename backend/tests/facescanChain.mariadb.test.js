/**
 * One day of facescan scans against the REAL schema, all the way to the monthly summary.
 *
 * The fixture tests prove the derivation rules; they cannot prove the SQL. `attendance_events`,
 * `daily_attendance` and `monthly_summary` writes were added without ever touching a database, and
 * the promotion has to be idempotent against both unique keys in 016 — which only a real
 * `ON DUPLICATE KEY` can show. The second `deriveDay` below is the point of this test.
 *
 * Skipped wherever no database is present.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured, createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createFacescanRawMariaDbRepository } = require('../src/repositories/mariadb/facescanRawMariaDbRepository');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../src/services/facescanAttendanceIngestionService');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const DATE = '2026-11-16'; // a Monday, inside a month that has a rule set
const SCANS = ['08:30:00', '16:30:00'];

test('a day of scans becomes events, a daily row and a monthly summary — once', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();
  const raw = createFacescanRawMariaDbRepository(pool);

  const [employees] = await pool.query("SELECT employee_uid FROM employees WHERE status = 'active' LIMIT 1");
  if (employees.length === 0) {
    t.skip('no active employee to derive attendance for');
    return;
  }
  const employeeUid = employees[0].employee_uid;
  const batchId = randomUUID();
  const keys = SCANS.map(() => randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64));
  let stagingIds = [];

  t.after(async () => {
    const cleanup = [
      ['DELETE FROM attendance_events WHERE employee_uid = ? AND event_time >= ? AND event_time < DATE_ADD(?, INTERVAL 1 DAY)', [employeeUid, DATE, DATE]],
      ['DELETE FROM daily_attendance WHERE employee_uid = ? AND date = ?', [employeeUid, DATE]],
      ['DELETE FROM monthly_summary WHERE employee_uid = ? AND year = 2026 AND month = 11', [employeeUid]],
      ['DELETE FROM staging_facescan_raw WHERE import_batch_uid = ?', [batchId]],
      ['DELETE FROM facescan_import_batches WHERE batch_uid = ?', [batchId]],
      ['DELETE FROM authorization_grants WHERE employee_uid = ? AND role = ?', [employeeUid, 'EXECUTIVE']],
    ];
    for (const [sql, params] of cleanup) await pool.query(sql, params).catch(() => {});
    await closePool();
  });

  // The day write refuses a caller without a covering grant, so grant the test employee one.
  await pool.query(
    'INSERT INTO authorization_grants (employee_uid, role, scope_type, created_at, updated_at) VALUES (?,?,?,NOW(),NOW())',
    [employeeUid, 'EXECUTIVE', 'organization'],
  );

  await raw.createBatch({ id: batchId, sourceSystem: 'hip_pm2014', sourceLabel: 'chain-test' });
  for (const [index, time] of SCANS.entries()) {
    const row = await raw.insertRawRow({
      batchId,
      facescanId: `CHAIN-${index}`,
      scanDatetime: `${DATE} ${time}`,
      scanType: index === 0 ? 'IN' : 'OUT',
      payloadJson: { ScanId: `CHAIN-${index}` },
      idempotencyKey: keys[index],
      resolutionStatus: 'unmapped',
    });
    await raw.resolveRow(row.id, { employeeUid, resolutionStatus: 'resolved' });
    stagingIds.push(row.id);
  }
  await raw.commitBatch(batchId);

  const recordService = createAttendanceRecordService({ repositories });
  const service = createFacescanAttendanceIngestionService({ repositories, recordService });
  const auth = { role: 'EXECUTIVE', employeeUid };

  const derived = await service.deriveDay(auth, employeeUid, DATE);
  assert.equal(derived.checkIn, '08:30');
  assert.equal(derived.checkOut, '16:30');
  assert.equal(derived.status, 'present');

  const [events] = await pool.query(
    'SELECT id, event_uid FROM attendance_events WHERE employee_uid = ? AND staging_facescan_raw_id IN (?) ORDER BY event_time',
    [employeeUid, stagingIds],
  );
  assert.equal(events.length, 2, 'each resolved scan is one event');

  const readDay = async () => {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(check_in, '%H:%i') AS check_in, DATE_FORMAT(check_out, '%H:%i') AS check_out,
              status, late_minutes, source_system, rule_version_code
         FROM daily_attendance WHERE employee_uid = ? AND date = ?`,
      [employeeUid, DATE],
    );
    return rows[0];
  };
  const first = await readDay();
  assert.equal(first.status, 'present');
  assert.equal(first.source_system, 'FACESCAN', 'provenance comes from the derivation, not the caller');
  assert.ok(first.check_in && first.check_out, 'both times must be stored');

  // The month is derived from every daily row in it, not just this one — compare against the rows
  // themselves so a database with other seeded days still asserts the real invariant.
  const [monthFirst] = await pool.query(
    'SELECT total_present FROM monthly_summary WHERE employee_uid = ? AND year = 2026 AND month = 11',
    [employeeUid],
  );
  const [[counted]] = await pool.query(
    `SELECT COUNT(*) AS present FROM daily_attendance
      WHERE employee_uid = ? AND YEAR(date) = 2026 AND MONTH(date) = 11 AND status <> 'pending'`,
    [employeeUid],
  );
  assert.equal(Number(monthFirst[0].total_present), Number(counted.present), 'recordDay re-derives the month');
  assert.ok(Number(counted.present) >= 1);

  // Replay: same scans, same day. Two unique keys in 016 must both hold.
  const again = await service.deriveDay(auth, employeeUid, DATE);
  assert.equal(again.eventCount, 2);
  const [eventsAgain] = await pool.query(
    'SELECT id FROM attendance_events WHERE employee_uid = ? AND staging_facescan_raw_id IN (?)',
    [employeeUid, stagingIds],
  );
  assert.equal(eventsAgain.length, 2, 'promotion is idempotent on the real UNIQUE keys');
  const second = await readDay();
  assert.deepEqual(second, first, 'the day row is upserted, not duplicated');
});
