/**
 * HIP file -> staging_facescan_raw -> identity resolution -> attendance_events -> daily_attendance
 * -> monthly_summary, against the real schema. Synthetic data only, on its own synthetic employee and
 * facescan ids so it cannot collide with concurrently running suites; everything is deleted after.
 *
 * TZ is pinned to UTC like the deploy containers. Skipped wherever no database is present.
 */
process.env.TZ = 'UTC';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { isDatabaseConfigured, createMariaDbRepositories } = require('../src/repositories/mariadbRepositories');
const { getPool, closePool } = require('../src/db/pool');
const { createFacescanRawIngestionService } = require('../src/services/facescanRawIngestionService');
const { createAttendanceRecordService } = require('../src/services/attendanceRecordService');
const { createFacescanAttendanceIngestionService } = require('../src/services/facescanAttendanceIngestionService');

function shouldRunMariaDb() {
  if (process.env.RUN_MARIADB_TESTS === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return isDatabaseConfigured();
  return false;
}

const DATE = '2026-11-18'; // a Wednesday under AR-0001

test('HIP file chain on MariaDB: Bangkok time, idempotent, unmapped quarantined, nothing invented', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();

  const employeeUid = randomUUID();
  const tag = employeeUid.slice(0, 8).toUpperCase();
  const known = `QAF-${tag}`;
  const unknown = `QAX-${tag}`;
  const file = [
    'facescan_id,scan_datetime,scan_type,display_name',
    `${known},${DATE} 08:41:00,in,Synthetic`,
    `${known},18/11/2569 12:02,,Synthetic`,
    `${known},${DATE}T16:35:00,out,Synthetic`,
    `${unknown},${DATE} 08:00:00,in,Nobody`,
  ].join('\r\n');

  t.after(async () => {
    const cleanup = [
      ['DELETE FROM attendance_events WHERE employee_uid = ? OR facescan_id IN (?, ?)', [employeeUid, known, unknown]],
      ['DELETE FROM daily_attendance WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM monthly_summary WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM staging_facescan_raw WHERE facescan_id IN (?, ?)', [known, unknown]],
      ["DELETE FROM facescan_import_batches WHERE source_system = 'hip_csv_export' AND source_reference LIKE ?", [`qa-file-${tag}%`]],
      ['DELETE FROM employee_identifier WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM authorization_grants WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM employees WHERE employee_uid = ?', [employeeUid]],
    ];
    for (const [sql, params] of cleanup) await pool.query(sql, params).catch(() => {});
    await closePool();
  });

  await pool.query(
    `INSERT INTO employees (
       employee_uid, employee_id, first_name_th, last_name_th, email, department, employee_type,
       status, role, login_attempts, created_at, updated_at
     ) VALUES (?, ?, 'ทดสอบ', 'ไฟล์', ?, 'สำนักงาน', 'university', 'active', 'user', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [employeeUid, `QAF-${tag}`, `qaf-${tag.toLowerCase()}@example.invalid`],
  );
  // Identity is decided by an approved identifier only; the unknown id deliberately has none.
  await pool.query(
    `INSERT INTO employee_identifier (employee_uid, id_type, id_value, source_system, is_primary, status, created_at, updated_at)
     VALUES (?, 'facescan_id', ?, 'qa-test', 0, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [employeeUid, known],
  );
  await pool.query(
    'INSERT INTO authorization_grants (employee_uid, role, scope_type, created_at, updated_at) VALUES (?,?,?,NOW(),NOW())',
    [employeeUid, 'EXECUTIVE', 'organization'],
  );

  // 1. file -> staging, with identity resolution
  const ingestion = createFacescanRawIngestionService({ repositories });
  const first = await ingestion.ingestFile(file, { sourceLabel: `qa-file-${tag}.csv` });
  assert.equal(first.batch.status, 'completed');
  assert.equal(first.batch.insertedCount, 4);
  assert.equal(first.batch.unmappedCount, 1);
  assert.equal(first.batch.resolvedCount, 3, 'derived from the staging rows themselves');

  const [staging] = await pool.query(
    `SELECT facescan_id, DATE_FORMAT(check_time, '%Y-%m-%d %H:%i:%s') AS check_time, check_type,
            employee_uid, resolution_status, source_system, raw_payload
       FROM staging_facescan_raw WHERE facescan_id IN (?, ?) ORDER BY check_time, facescan_id`,
    [known, unknown],
  );
  assert.equal(staging.length, 4);
  // Staging keeps the Bangkok wall clock verbatim; the BE line became CE.
  assert.deepEqual(staging.map((row) => row.check_time), [
    `${DATE} 08:00:00`, `${DATE} 08:41:00`, `${DATE} 12:02:00`, `${DATE} 16:35:00`,
  ]);
  assert.ok(staging.every((row) => row.source_system === 'hip_csv_export'));
  assert.ok(staging.every((row) => !JSON.stringify(row.raw_payload).includes('Synthetic')), 'no names in staging');
  const quarantined = staging.filter((row) => row.facescan_id === unknown);
  assert.equal(quarantined[0].resolution_status, 'unmapped');
  assert.equal(quarantined[0].employee_uid, null);
  assert.ok(staging.filter((row) => row.facescan_id === known).every((row) => (
    row.resolution_status === 'resolved' && row.employee_uid === employeeUid
  )));

  // 2. re-import: zero new rows
  const again = await ingestion.ingestFile(file, { sourceLabel: `qa-file-${tag}.csv` });
  assert.equal(again.batch.insertedCount, 0);
  assert.equal(again.batch.duplicateCount, 4);
  const [[{ n: stagingAfter }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM staging_facescan_raw WHERE facescan_id IN (?, ?)', [known, unknown],
  );
  assert.equal(Number(stagingAfter), 4);

  // 3. staging -> events -> daily -> monthly
  const recordService = createAttendanceRecordService({ repositories });
  const derive = createFacescanAttendanceIngestionService({ repositories, recordService });
  const auth = { role: 'EXECUTIVE', employeeUid };
  const day = await derive.deriveDay(auth, employeeUid, DATE);
  assert.equal(day.checkIn, '08:41');
  assert.equal(day.checkOut, '16:35');
  assert.equal(day.status, 'late');
  assert.equal(day.lateMinutes, 11);
  assert.equal(day.eventCount, 3);
  await derive.deriveDay(auth, employeeUid, DATE); // replay

  const [[events]] = await pool.query(
    `SELECT SUM(employee_uid = ?) AS mine, SUM(facescan_id = ?) AS quarantined
       FROM attendance_events WHERE facescan_id IN (?, ?)`,
    [employeeUid, unknown, known, unknown],
  );
  assert.equal(Number(events.mine), 3, 'one event per resolved scan, replay-safe');
  assert.equal(Number(events.quarantined || 0), 0, 'an unmapped scan never becomes an event');

  const [daily] = await pool.query(
    `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date,
            DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in,
            DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out,
            DATE_FORMAT(first_event_at, '%Y-%m-%d %H:%i:%s') AS first_event_at,
            DATE_FORMAT(last_event_at, '%Y-%m-%d %H:%i:%s') AS last_event_at,
            status, late_minutes, rule_version_code, source_system, source_event_count
       FROM daily_attendance WHERE employee_uid = ?`,
    [employeeUid],
  );
  assert.equal(daily.length, 1, 'only the scanned day exists; no other day is invented');
  assert.deepEqual(daily[0], {
    date: DATE,
    check_in: `${DATE} 01:41:00`, // 08:41 Bangkok
    check_out: `${DATE} 09:35:00`, // 16:35 Bangkok
    first_event_at: `${DATE} 01:41:00`,
    last_event_at: `${DATE} 09:35:00`,
    status: 'late',
    late_minutes: 11,
    rule_version_code: 'AR-0001',
    source_system: 'FACESCAN',
    source_event_count: 3,
  });

  const [monthly] = await pool.query(
    `SELECT total_present, total_late, total_absent, total_late_minutes, computation_status
       FROM monthly_summary WHERE employee_uid = ? AND year = 2026 AND month = 11`,
    [employeeUid],
  );
  assert.equal(monthly.length, 1);
  assert.deepEqual(
    { ...monthly[0], total_present: Number(monthly[0].total_present) },
    { total_present: 1, total_late: 1, total_absent: 0, total_late_minutes: 11, computation_status: 'calculated' },
  );
});
