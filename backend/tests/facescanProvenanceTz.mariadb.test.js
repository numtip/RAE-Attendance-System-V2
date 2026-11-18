/**
 * QA-1 against the real schema: a facescan-derived day must store first_event_at / last_event_at at
 * the same instants as check_in / check_out. The fixture regression proves the service; only a real
 * DATETIME round-trip through the 'Z' pool proves what lands in daily_attendance.
 *
 * The process timezone is pinned to UTC, as in the deploy containers, so a Bangkok-local machine
 * cannot hide the shift. Uses its own synthetic employee so it cannot collide with other suites
 * that run concurrently. Skipped wherever no database is present.
 */
process.env.TZ = 'UTC';

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

const DATE = '2026-11-17'; // a Tuesday under AR-0001
const SCANS = ['08:30:00', '12:05:00', '16:45:00'];

test('QA-1: facescan first/last event instants equal the stored check-in/out on MariaDB', { skip: !shouldRunMariaDb() }, async (t) => {
  const config = require('../src/config');
  const pool = getPool(config.database);
  const repositories = createMariaDbRepositories();
  const raw = createFacescanRawMariaDbRepository(pool);

  const employeeUid = randomUUID();
  const tag = employeeUid.slice(0, 8);
  const batchId = randomUUID();

  t.after(async () => {
    const cleanup = [
      ['DELETE FROM attendance_events WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM daily_attendance WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM monthly_summary WHERE employee_uid = ?', [employeeUid]],
      ['DELETE FROM staging_facescan_raw WHERE import_batch_uid = ?', [batchId]],
      ['DELETE FROM facescan_import_batches WHERE batch_uid = ?', [batchId]],
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
     ) VALUES (?, ?, 'ทดสอบ', 'เวลา', ?, 'สำนักงาน', 'university', 'active', 'user', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [employeeUid, `QA1-${tag}`, `qa1-${tag}@example.invalid`],
  );
  await pool.query(
    'INSERT INTO authorization_grants (employee_uid, role, scope_type, created_at, updated_at) VALUES (?,?,?,NOW(),NOW())',
    [employeeUid, 'EXECUTIVE', 'organization'],
  );

  await raw.createBatch({ id: batchId, sourceSystem: 'hip_pm2014', sourceLabel: 'qa1-tz-test' });
  for (const [index, time] of SCANS.entries()) {
    const row = await raw.insertRawRow({
      batchId,
      facescanId: `QA1-${tag}-${index}`,
      scanDatetime: `${DATE} ${time}`,
      scanType: null,
      payloadJson: { synthetic: true, index },
      idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      resolutionStatus: 'unmapped',
    });
    await raw.resolveRow(row.id, { employeeUid, resolutionStatus: 'resolved' });
  }
  await raw.commitBatch(batchId);

  const recordService = createAttendanceRecordService({ repositories });
  const service = createFacescanAttendanceIngestionService({ repositories, recordService });
  const derived = await service.deriveDay({ role: 'EXECUTIVE', employeeUid }, employeeUid, DATE);
  assert.equal(derived.checkIn, '08:30');
  assert.equal(derived.checkOut, '16:45');

  const [[day]] = await pool.query(
    `SELECT DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in,
            DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out,
            DATE_FORMAT(first_event_at, '%Y-%m-%d %H:%i:%s') AS first_event_at,
            DATE_FORMAT(last_event_at, '%Y-%m-%d %H:%i:%s') AS last_event_at,
            source_event_count
       FROM daily_attendance WHERE employee_uid = ? AND date = ?`,
    [employeeUid, DATE],
  );
  // 08:30 / 16:45 Bangkok (UTC+7) are stored as UTC instants by the 'Z' pool.
  assert.equal(day.check_in, '2026-11-17 01:30:00');
  assert.equal(day.check_out, '2026-11-17 09:45:00');
  assert.equal(day.first_event_at, day.check_in, 'first_event_at must be the check-in instant');
  assert.equal(day.last_event_at, day.check_out, 'last_event_at must be the check-out instant');
  assert.equal(Number(day.source_event_count), SCANS.length);
});
