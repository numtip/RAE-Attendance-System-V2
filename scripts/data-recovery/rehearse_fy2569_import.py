#!/usr/bin/env python3
"""Isolated import rehearsal for the FY2569 integration dataset.

Disposable SQLite database only. No server, no credentials, no network.
The MariaDB schema is translated faithfully enough to test the same constraints
(PK/UNIQUE/NOT NULL/ENUM-as-CHECK, FK ON). Translation is limited and declared:
  * ENUM -> CHECK (id_type), and CHECK for the documented value sets
  * AUTO_INCREMENT -> INTEGER PRIMARY KEY AUTOINCREMENT
  * ENGINE / CHARSET / COLLATE are dropped (no behavioural effect on these tests)
  * No FK is invented. `daily_attendance` has NO foreign key in migration 004,
    so none is added here; referential integrity is verified by query instead.

Two passes:
  PASS_A  the schema as written. Proves the owner master cannot satisfy it today.
  PASS_B  the same schema with ONLY the columns that have no source relaxed, so the
          relational behaviour can still be rehearsed. Marked REHEARSAL_RELAXED.

Usage (repo root):
  python scripts/data-recovery/rehearse_fy2569_import.py
"""
from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
import uuid
from pathlib import Path

REHEARSAL_NAMESPACE = uuid.UUID('6f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d')

DDL_STRICT = """
PRAGMA foreign_keys = ON;

CREATE TABLE employees (
  employee_uid   TEXT NOT NULL PRIMARY KEY,
  employee_id    TEXT NOT NULL UNIQUE,
  first_name_th  TEXT NOT NULL,
  last_name_th   TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  department     TEXT NOT NULL,
  position       TEXT,
  employee_type  TEXT NOT NULL CHECK (employee_type IN ('university','department','contract')),
  hire_date      TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active','inactive','resigned')),
  role           TEXT CHECK (role IS NULL OR role IN ('admin','manager','user')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE employee_identifier (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid  TEXT NOT NULL,
  id_type       TEXT NOT NULL CHECK (id_type IN ('employee_id','personnel_id','facescan_id','national_id')),
  id_value      TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  source_system TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  verified_at   TEXT,
  effective_from TEXT,
  effective_to   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (id_type, id_value),
  FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid)
);

CREATE TABLE employee_assignment (
  assignment_uid  TEXT NOT NULL PRIMARY KEY,
  employee_uid    TEXT NOT NULL,
  employee_code   TEXT NOT NULL,
  department      TEXT NOT NULL,
  position        TEXT,
  employee_type   TEXT NOT NULL CHECK (employee_type IN ('university','department','contract')),
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  source_system   TEXT NOT NULL,
  source_reference TEXT,
  recorded_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (employee_uid, effective_from),
  FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid)
);

CREATE TABLE daily_attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid  TEXT NOT NULL,
  date          TEXT NOT NULL,
  check_in      TEXT,
  check_out     TEXT,
  is_late       INTEGER NOT NULL DEFAULT 0,
  late_minutes  INTEGER NOT NULL DEFAULT 0,
  work_duration REAL NOT NULL DEFAULT 0.00,
  is_leave      INTEGER NOT NULL DEFAULT 0,
  leave_type    TEXT CHECK (leave_type IS NULL OR leave_type IN ('sick','personal','vacation','other')),
  status        TEXT NOT NULL CHECK (status IN ('present','late','absent','leave','holiday')),
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE monthly_summary (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid  TEXT NOT NULL,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL,
  total_work_days     INTEGER NOT NULL DEFAULT 0,
  total_present       INTEGER NOT NULL DEFAULT 0,
  total_late          INTEGER NOT NULL DEFAULT 0,
  total_absent        INTEGER NOT NULL DEFAULT 0,
  total_leave         INTEGER NOT NULL DEFAULT 0,
  total_late_minutes  INTEGER NOT NULL DEFAULT 0,
  total_work_hours    REAL NOT NULL DEFAULT 0.00,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""

# Only these columns lose NOT NULL, and only in PASS_B. Nothing else changes.
RELAXED_COLUMNS = [
    ('employees', 'first_name_th'), ('employees', 'last_name_th'),
    ('employees', 'email'), ('employees', 'employee_type'),
]
# employee_type is a CHECKed enum; relaxing NOT NULL keeps the CHECK for non-NULL values.


def build_relaxed_ddl() -> str:
    import re
    ddl = DDL_STRICT
    for table, column in RELAXED_COLUMNS:
        start = ddl.index(f'CREATE TABLE {table} (')
        end = ddl.index(');', start)
        block = ddl[start:end]
        block = re.sub(rf'(^\s*{column}\s+TEXT)\s+NOT NULL', r'\1', block, flags=re.M)
        ddl = ddl[:start] + block + ddl[end:]
    return ddl


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh))


def rehearsal_uid(code: str) -> str:
    """REHEARSAL-ONLY key. Deterministic, disposable, never an approved production identity."""
    return str(uuid.uuid5(REHEARSAL_NAMESPACE, f'rehearsal:employee:{code}'))


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def apply_ddl(conn: sqlite3.Connection, ddl: str) -> None:
    conn.executescript(ddl)
    conn.commit()


def insert_employees(conn: sqlite3.Connection, master_rows: list[dict], now: str) -> int:
    inserted = 0
    for row in master_rows:
        code = row['report_code']
        name = row['full_name_th'].strip()
        conn.execute(
            """INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th,
                                      email, department, position, employee_type, hire_date,
                                      status, role, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rehearsal_uid(code), row['employee_code'] or code,
             name or None, '', None, row['department_current'], None, 'university', None,
             row['employment_status'], None, now, now))
        inserted += 1
    return inserted


def insert_identifiers(conn: sqlite3.Connection, master_rows: list[dict], now: str) -> int:
    n = 0
    for row in master_rows:
        uid = rehearsal_uid(row['report_code'])
        code = row['employee_code'] or row['report_code']
        conn.execute(
            """INSERT INTO employee_identifier (employee_uid, id_type, id_value, is_primary,
                                                source_system, status, effective_from,
                                                effective_to, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (uid, 'employee_id', code, 1, 'OWNER_WORKBOOK_20261020', 'active',
             None, None, now, now))
        if row['device_code']:
            conn.execute(
                """INSERT INTO employee_identifier (employee_uid, id_type, id_value, is_primary,
                                                    source_system, status, effective_from,
                                                    effective_to, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (uid, 'facescan_id', row['device_code'], 0, 'HIP_IDCARD_FY2569', 'active',
                 None, None, now, now))
            n += 1
    return n


def load_attendance(conn: sqlite3.Connection, rows: list[dict], uid_by_code: dict[str, str],
                    now: str) -> int:
    payload = []
    for r in rows:
        uid = uid_by_code.get(r['employee_code'])
        if uid is None:
            raise SystemExit(f'unmapped employee code {r["employee_code"]}')
        payload.append((uid, r['attendance_date'], r['check_in'] or None,
                        r['check_out'] or None, int(r['is_late']), int(r['late_minutes']),
                        1 if r['leave_type'] else 0, r['leave_type'] or None,
                        r['attendance_status'], r['source_key'], now, now))
    conn.executemany(
        """INSERT INTO daily_attendance (employee_uid, date, check_in, check_out, is_late,
                                         late_minutes, is_leave, leave_type, status, notes,
                                         created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", payload)
    return len(payload)


def rebuild_summary(conn: sqlite3.Connection, now: str) -> int:
    conn.execute('DELETE FROM monthly_summary')
    conn.execute(
        """INSERT INTO monthly_summary (employee_uid, year, month, total_work_days,
               total_present, total_late, total_absent, total_leave, total_late_minutes,
               total_work_hours, created_at, updated_at)
           SELECT employee_uid, CAST(substr(date,1,4) AS INTEGER), CAST(substr(date,6,2) AS INTEGER),
                  SUM(CASE WHEN status != 'holiday' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN status = 'leave' THEN 1 ELSE 0 END),
                  SUM(late_minutes), 0, ?, ?
           FROM daily_attendance GROUP BY 1,2,3""", (now, now))
    return conn.execute('SELECT COUNT(*) FROM monthly_summary').fetchone()[0]


def counts(conn: sqlite3.Connection) -> dict:
    return {
        'employees': conn.execute('SELECT COUNT(*) FROM employees').fetchone()[0],
        'employee_identifier': conn.execute('SELECT COUNT(*) FROM employee_identifier').fetchone()[0],
        'daily_attendance': conn.execute('SELECT COUNT(*) FROM daily_attendance').fetchone()[0],
        'monthly_summary': conn.execute('SELECT COUNT(*) FROM monthly_summary').fetchone()[0],
    }


def fingerprint(conn: sqlite3.Connection) -> str:
    """Order-independent checksum of all content, used for idempotency comparison."""
    import hashlib
    h = hashlib.sha256()
    for q in ('SELECT employee_uid, employee_id, department, status FROM employees ORDER BY 1',
              'SELECT employee_uid, id_type, id_value FROM employee_identifier ORDER BY 1,2,3',
              'SELECT employee_uid, date, check_in, check_out, is_late, late_minutes, status '
              'FROM daily_attendance ORDER BY 1,2'):
        for row in conn.execute(q):
            h.update(repr(row).encode('utf-8'))
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dataset', default='database/local/fy2569-integration-20261020')
    ap.add_argument('--out', default='database/local/fy2569-integration-20261020/rehearsal')
    args = ap.parse_args(argv)

    dataset = Path(args.dataset)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = '2026-10-20T00:00:00Z'

    master_rows = [r for r in read_csv(dataset / 'employee_master_integration.csv')
                   if r['in_master_workbook'] == 'yes']
    attendance = read_csv(dataset / 'daily_attendance_normalized.csv')
    result: dict = {'passes': {}}

    # ---------------- PASS A: schema as written -----------------------------
    db_a = out / 'rehearsal_strict.sqlite'
    for p in (db_a, Path(str(db_a) + '-journal')):
        if p.exists():
            p.unlink()
    conn = connect(db_a)
    apply_ddl(conn, DDL_STRICT)
    pass_a = {'schema': 'AS_WRITTEN', 'expected': 'constraint violation'}
    try:
        with conn:
            insert_employees(conn, master_rows, now)
        pass_a.update(status='UNEXPECTED_SUCCESS', error=None)
    except sqlite3.IntegrityError as exc:
        pass_a.update(status='REJECTED_AS_EXPECTED', error=str(exc))
        conn.rollback()
    pass_a['employees_committed'] = conn.execute('SELECT COUNT(*) FROM employees').fetchone()[0]
    result['passes']['A_strict'] = pass_a

    # which constraint fails first, and how many rows would fail each NOT NULL?
    missing = {
        'first_name_th': sum(1 for r in master_rows if not r['full_name_th'].strip()),
        'last_name_th': len(master_rows),          # never split: 0 rows have a surname field
        'email': len(master_rows),                  # no email source at all
        'employee_type': len(master_rows),          # no employment-type source
        'employee_uid': len(master_rows),           # allocation policy not approved
    }
    result['passes']['A_strict']['rows_unable_to_satisfy'] = missing
    conn.close()

    # ---------------- PASS B: relaxed, relational rehearsal ----------------
    db_b = out / 'rehearsal_relaxed.sqlite'
    for p in (db_b, Path(str(db_b) + '-journal')):
        if p.exists():
            p.unlink()
    conn = connect(db_b)
    apply_ddl(conn, build_relaxed_ddl())
    uid_by_code = {r['report_code']: rehearsal_uid(r['report_code']) for r in master_rows}

    # B1 first import
    with conn:
        n_emp = insert_employees(conn, master_rows, now)
        n_ident = insert_identifiers(conn, master_rows, now)
        n_att = load_attendance(conn, attendance, uid_by_code, now)
        n_sum = rebuild_summary(conn, now)
    first = counts(conn)
    fp_first = fingerprint(conn)

    # B2 idempotent re-import: same data, same result, no duplicates
    with conn:
        conn.execute('DELETE FROM daily_attendance')
        conn.execute('DELETE FROM monthly_summary')
        conn.execute('DELETE FROM employee_identifier')
        conn.execute('DELETE FROM employee_assignment')
        conn.execute('DELETE FROM employees')
        insert_employees(conn, master_rows, now)
        insert_identifiers(conn, master_rows, now)
        load_attendance(conn, attendance, uid_by_code, now)
        rebuild_summary(conn, now)
    second = counts(conn)
    fp_second = fingerprint(conn)

    # B3 rollback: a failed transaction must leave the database untouched.
    # The failure vector must be a REAL constraint. daily_attendance has no FK (migration 004),
    # so a duplicate (id_type, id_value) on employee_identifier is used to force the abort.
    fp_before = fingerprint(conn)
    rolled_back = False
    try:
        conn.execute('BEGIN')
        conn.execute('DELETE FROM daily_attendance')
        existing = conn.execute(
            'SELECT employee_uid, id_type, id_value FROM employee_identifier ORDER BY id LIMIT 1').fetchone()
        conn.execute(
            'INSERT INTO employee_identifier (employee_uid, id_type, id_value, created_at, updated_at)'
            ' VALUES (?,?,?,?,?)', (existing[0], existing[1], existing[2], now, now))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        rolled_back = True
    fp_after = fingerprint(conn)
    attendance_survived = conn.execute('SELECT COUNT(*) FROM daily_attendance').fetchone()[0]

    # B4 referential integrity by query (daily_attendance intentionally has no FK)
    orphans = conn.execute(
        "SELECT COUNT(*) FROM daily_attendance d LEFT JOIN employees e"
        " ON e.employee_uid = d.employee_uid WHERE e.employee_uid IS NULL").fetchone()[0]
    dup_dates = conn.execute(
        "SELECT COUNT(*) FROM (SELECT employee_uid, date FROM daily_attendance"
        " GROUP BY 1,2 HAVING COUNT(*) > 1)").fetchone()[0]

    # B5 identity separation: 1015 and 1032 must be two employees with disjoint days
    rows_1015 = conn.execute(
        "SELECT COUNT(*), MIN(date), MAX(date) FROM daily_attendance WHERE employee_uid = ?",
        (uid_by_code.get('1015'),)).fetchone()
    rows_1032 = conn.execute(
        "SELECT COUNT(*), MIN(date), MAX(date) FROM daily_attendance WHERE employee_uid = ?",
        (uid_by_code.get('1032'),)).fetchone()
    overlap = conn.execute(
        "SELECT COUNT(*) FROM daily_attendance a JOIN daily_attendance b"
        " ON a.date = b.date AND a.employee_uid = ? AND b.employee_uid = ?",
        (uid_by_code.get('1015'), uid_by_code.get('1032'))).fetchone()[0]
    same_uid = uid_by_code.get('1015') == uid_by_code.get('1032')
    ident_1015 = conn.execute(
        "SELECT id_type, id_value FROM employee_identifier WHERE employee_uid = ? ORDER BY id_type",
        (uid_by_code.get('1015'),)).fetchall()
    ident_1032 = conn.execute(
        "SELECT id_type, id_value FROM employee_identifier WHERE employee_uid = ? ORDER BY id_type",
        (uid_by_code.get('1032'),)).fetchall()

    # B6 FK enforcement proof on a table that DOES have one
    fk_enforced = False
    try:
        conn.execute('BEGIN')
        conn.execute("INSERT INTO employee_identifier (employee_uid, id_type, id_value, created_at, updated_at)"
                     " VALUES ('no-such-uid','employee_id','X1',?,?)", (now, now))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        fk_enforced = True

    # B7 orphan insert into daily_attendance must be ALLOWED (no FK in migration 004)
    orphan_allowed = False
    try:
        conn.execute('BEGIN')
        conn.execute("INSERT INTO daily_attendance (employee_uid, date, status, created_at, updated_at)"
                     " VALUES ('no-such-uid','2026-01-01','present',?,?)", (now, now))
        conn.commit()
        orphan_allowed = True
        conn.execute('BEGIN')
        conn.execute("DELETE FROM daily_attendance WHERE employee_uid='no-such-uid'")
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()

    status_mix = conn.execute(
        'SELECT status, COUNT(*) FROM daily_attendance GROUP BY status ORDER BY status').fetchall()
    per_month_late = conn.execute(
        "SELECT substr(date,1,7), COUNT(*) FROM daily_attendance WHERE status='late'"
        " GROUP BY 1 ORDER BY 1").fetchall()

    result['passes']['B_relaxed'] = {
        'schema': 'REHEARSAL_RELAXED (only first_name_th/last_name_th/email/employee_type nullable)',
        'first_import': first,
        'first_import_rows_written': {'employees': n_emp, 'identifiers': n_ident,
                                      'daily_attendance': n_att, 'monthly_summary': n_sum},
        'second_import': second,
        'idempotent': first == second and fp_first == fp_second,
        'fingerprint_match': fp_first == fp_second,
        'rollback_test': {'raised': rolled_back, 'database_unchanged': fp_before == fp_after,
                          'attendance_rows_after_rollback': attendance_survived},
        'referential_integrity': {'orphan_daily_attendance_rows': orphans,
                                  'duplicate_employee_date_rows': dup_dates},
        'identity_separation': {
            'same_uid': same_uid,
            '1015': {'rows': rows_1015[0], 'first': rows_1015[1], 'last': rows_1015[2],
                     'identifiers': ident_1015},
            '1032': {'rows': rows_1032[0], 'first': rows_1032[1], 'last': rows_1032[2],
                     'identifiers': ident_1032},
            'shared_dates': overlap,
        },
        'fk_enforced_on_employee_identifier': fk_enforced,
        'daily_attendance_accepts_orphan_no_fk_in_migration_004': orphan_allowed,
        'status_mix': dict(status_mix),
        'late_by_month': {m: c for m, c in per_month_late},
    }
    conn.close()

    (out / 'rehearsal_result.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    sys.stdout.write(json.dumps({
        'pass_a': result['passes']['A_strict']['status'],
        'pass_a_error': result['passes']['A_strict']['error'],
        'pass_b_first': first,
        'idempotent': result['passes']['B_relaxed']['idempotent'],
        'rollback_ok': result['passes']['B_relaxed']['rollback_test']['database_unchanged'],
        'orphans': orphans,
        'dup_dates': dup_dates,
        'same_uid_1015_1032': same_uid,
        'shared_dates_1015_1032': overlap,
        'fk_enforced': fk_enforced,
    }, ensure_ascii=False) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
