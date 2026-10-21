/**
 * Read-only FY2569 adapter. Prints counts only. Writes no production database.
 * Source files stay outside this repo. A summary with no names is written under .local/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import { createApp } from '../src/app.js';
import { createContainer } from '../src/container.js';
import { buildFy2569Plan } from '../src/imports/fy2569Plan.js';

const sourceRoot = process.argv[2] || 'G:\\ProjectAI\\attendance-report-generator';
const prepared = path.join(sourceRoot, 'CodexWorker', 'prepared');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((item) => item.some((cell) => cell !== ''));
  if (header && header[0]) header[0] = header[0].replace(/^\uFEFF/, '');
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

function read(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

// ADR-012 rule 3: an `employee_uid` is never derived from a person code. This harness previously built one with
// sha256("fy2569:" + code) shaped like a UUID, which is fully reproducible from a public code and would pass a
// v4-shaped database CHECK. It now allocates a fresh UUIDv4 per person at import time; the in-memory `uidByCode`
// map below keeps attendance/leave consistent within a run, and that is all the determinism this needs.

const peopleRows = read(path.join(sourceRoot, 'docs', 'dataperson.csv'));
const eventRows = read(path.join(prepared, 'events.csv'));
const leaveRows = read(path.join(prepared, 'half_day_leave.csv'));
const reviewRows = read(path.join(prepared, 'needs_review.csv'));
const summaryRows = read(path.join(prepared, 'monthly_summary.csv'));

const plan = buildFy2569Plan({
  people: peopleRows.map((row) => ({
    code: row.code,
    name: row['ชื่อ-สกุล'],
    department: row['หน่วยงาน'],
  })),
  events: eventRows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    date: row.date_iso,
    eventType: row.event_type,
    actualTime: row.actual_time,
    deviation: row.deviation_hms,
  })),
  leave: leaveRows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    date: row.date_iso,
    leaveType: row.leave_type,
  })),
  review: reviewRows.map((row) => ({ employeeId: row.employee_id })),
  summary: summaryRows.map((row) => ({
    year: Number(row.year_be) - 543,
    month: Number(row.month),
    employeeId: row.employee_id,
    lateCount: Number(row.late_count),
    earlyCount: Number(row.early_leave_count),
    reportLate: Number(row.monthly_report_late),
    reportEarly: Number(row.monthly_report_early),
  })),
});

const passwordHash = bcrypt.hashSync('fy2569-local-only', 8);
const employees = plan.people.map((person) => {
  const [firstNameTh, ...rest] = String(person.name).split(' ');
  return {
    employeeUid: randomUUID(),
    employeeId: String(person.code),
    firstNameTh: firstNameTh || '-',
    lastNameTh: rest.join(' ') || '-',
    email: `e${person.code}@fy2569.local`,
    passwordHash,
    department: person.department || '-',
    position: '-',
    employeeType: 'department',
    status: 'active',
    role: 'user',
    lockedUntil: null,
  };
});
const uidByCode = new Map(employees.map((row) => [row.employeeId, row.employeeUid]));
const attendance = plan.attendance
  .filter((row) => uidByCode.has(row.employeeId))
  .map((row) => ({
    employeeUid: uidByCode.get(row.employeeId),
    date: row.date,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    status: row.status,
    isLate: row.status === 'late',
    lateMinutes: row.lateMinutes,
    workDuration: 0,
  }));
const leave = plan.leaveRows
  .filter((row) => uidByCode.has(row.employeeId))
  .map((row, index) => ({
    leaveId: `FY-${index + 1}`,
    employeeUid: uidByCode.get(row.employeeId),
    leaveType: row.leaveType,
    startDate: row.date,
    endDate: row.date,
    status: 'approved',
    matchStatus: 'matched',
  }));

const counts = {
  matchedEmployees: plan.matchedEmployees,
  blockedEmployees: plan.blockedEmployees,
  unmatchedCodes: plan.gaps.unmatchedCodes.length,
  nameConflicts: plan.gaps.nameConflicts,
  sourceLate: plan.sourceLate,
  sourceEarly: plan.sourceEarly,
  sourceLeave: plan.sourceLeave,
  importedLate: plan.late,
  importedEarly: plan.early,
  importedLeave: plan.leave,
  attendanceDays: plan.attendanceDays,
  withheldReview: plan.gaps.withheldReview,
  outsidePeriod: plan.gaps.outsidePeriod,
  unknownLeaveType: plan.gaps.unknownLeaveType,
  mismatchPersonMonths: plan.gaps.mismatchPersonMonths,
  marchMismatchPersonMonths: plan.gaps.marchMismatchPersonMonths,
  missingMonths: plan.gaps.missingMonths.length,
  codeGaps: plan.gaps.codeGaps,
  parity: {
    late: plan.sourceLate === 1600,
    early: plan.sourceEarly === 24,
    leave: plan.sourceLeave === 11,
    review: plan.gaps.withheldReview === 8,
    mismatches: plan.gaps.mismatchPersonMonths === 26,
  },
};

const outDir = path.join(repoRoot, '.local');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'fy2569-import-summary.json'), `${JSON.stringify(counts, null, 2)}\n`);

if (process.env.FY2569_COUNTS_ONLY === '1') {
  console.log(JSON.stringify({ counts }));
  process.exit(counts.parity.late && counts.parity.early && counts.parity.leave && counts.parity.review ? 0 : 1);
}

const mysql = require('mysql2/promise');
const dbHost = process.env.DB_HOST || '';
const localHost = dbHost === '127.0.0.1' || dbHost.startsWith('172.') || dbHost.startsWith('192.168.');
if (!localHost || process.env.DB_NAME !== 'attendance_fy2569_local') {
  throw new Error('Refusing to write: database must be the local disposable attendance_fy2569_local');
}
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
});
await connection.query('DELETE FROM employee_leave');
await connection.query('DELETE FROM daily_attendance');
await connection.query('DELETE FROM refresh_tokens');
await connection.query('DELETE FROM auth_logs');
await connection.query('DELETE FROM employees');
for (const row of employees) {
  await connection.query(
    `INSERT INTO employees (
      employee_uid, employee_id, first_name_th, last_name_th, email, password_hash,
      department, position, employee_type, status, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [
      row.employeeUid, row.employeeId, row.firstNameTh, row.lastNameTh, row.email, row.passwordHash,
      row.department, row.position, row.employeeType, row.status, row.role,
    ],
  );
}
for (const row of attendance) {
  await connection.query(
    `INSERT INTO daily_attendance (
      employee_uid, date, check_in, check_out, is_late, late_minutes, work_duration,
      is_leave, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [
      row.employeeUid,
      row.date,
      row.checkIn ? row.checkIn.slice(0, 19).replace('T', ' ') : null,
      row.checkOut ? row.checkOut.slice(0, 19).replace('T', ' ') : null,
      row.isLate ? 1 : 0,
      row.lateMinutes,
      row.status === 'late' ? 'late' : 'present',
    ],
  );
}
for (const row of leave) {
  await connection.query(
    `INSERT INTO employee_leave (
      leave_id, employee_uid, leave_type, start_date, end_date, status, match_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'approved', 'matched', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [row.leaveId, row.employeeUid, row.leaveType, row.startDate, row.endDate],
  );
}
const [loaded] = await connection.query(
  `SELECT
     (SELECT COUNT(*) FROM employees) AS employees,
     (SELECT COUNT(*) FROM daily_attendance) AS attendance,
     (SELECT COUNT(*) FROM employee_leave) AS leave_rows,
     (SELECT COUNT(*) FROM monthly_summary) AS monthly_rows`,
);
await connection.end();
counts.loaded = {
  employees: Number(loaded[0].employees),
  attendance: Number(loaded[0].attendance),
  leave: Number(loaded[0].leave_rows),
  monthlyRows: Number(loaded[0].monthly_rows),
};

const container = createContainer();
const app = createApp({ container });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

async function login(code) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e${code}@fy2569.local`, password: 'fy2569-local-only' }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`login ${response.status}`);
  return body.data;
}

const first = employees[0];
const second = employees[1];
const session = await login(first.employeeId);
const own = await fetch(`http://127.0.0.1:${port}/api/v1/reports/personal?year=2025&month=10`, {
  headers: { authorization: `Bearer ${session.accessToken}` },
});
const ownBody = await own.json();
const other = await fetch(
  `http://127.0.0.1:${port}/api/v1/reports/personal?year=2025&month=10&employeeUid=${second.employeeUid}`,
  { headers: { authorization: `Bearer ${session.accessToken}` } },
);
server.close();

const access = {
  selfStatus: own.status,
  selfEmployeeId: ownBody.data?.employeeId === first.employeeId,
  crossUserStatus: other.status,
};
console.log(JSON.stringify({ counts, access }));
server.close();
process.exit(
  counts.parity.late && counts.parity.early && counts.parity.leave && counts.parity.review
    && access.crossUserStatus === 403 && access.selfEmployeeId
    ? 0
    : 1,
);
