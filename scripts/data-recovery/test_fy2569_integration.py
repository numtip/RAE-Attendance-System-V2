"""Regression tests for the FY2569 integration builder and the import rehearsal.

Synthetic rows only — no real attendance data, codes or names.
"""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_fy2569_integration as build  # noqa: E402
import rehearse_fy2569_import as rehearse  # noqa: E402
import sqlite3  # noqa: E402

HEADER = ['รหัสที่เครื่อง', 'ชื่อพนักงาน', 'แผนก', 'วัน/เวลา', 'สถานะ',
          'เข้า [1]', 'ออก [1]', 'สาย [1]', 'ออกก่อน [1]', 'Remark [1]', '']
HEADER_NO_STATUS = ['รหัสที่เครื่อง', 'ชื่อพนักงาน', 'แผนก', 'วัน/เวลา',
                    'เข้า [1]', 'ออก [1]', 'สาย [1]', 'ออกก่อน [1]', 'Remark [1]', '']
HOLIDAYS = {'ขึ้นปีใหม่'}


def row(code='9001', when='1/10/2568', status='วันทำงาน', cin='08:00:00',
        cout='17:00:00', late='', early='', remark=''):
    return [code, 'SYNTHETIC PERSON', 'SYNTHETIC UNIT', when, status,
            cin, cout, late, early, remark, '']


def row_ns(code='9001', when='1/10/2568', cin='08:00:00', cout='17:00:00',
           late='', early='', remark=''):
    return [code, 'SYNTHETIC PERSON', 'SYNTHETIC UNIT', when,
            cin, cout, late, early, remark, '']


def row_short(code='9001', when='1/10/2568', cin='08:00:00', cout='17:00:00',
              late='', early='', remark=''):
    return [code, 'SYNTHETIC PERSON', 'SYNTHETIC UNIT', when, cin, cout, late, early, remark]


class DecodeTests(unittest.TestCase):
    def test_bom_is_stripped(self):
        text, enc = build.decode_bytes(b'\xef\xbb\xbfcode,date\n')
        self.assertEqual(enc, 'utf-8-sig(BOM)')
        self.assertTrue(text.startswith('code'))

    def test_plain_utf8(self):
        text, enc = build.decode_bytes('หน่วยงาน,1\n'.encode('utf-8'))
        self.assertEqual(enc, 'utf-8')
        self.assertIn('หน่วยงาน', text)


class DateTests(unittest.TestCase):
    def test_buddhist_era_slash_format(self):
        self.assertEqual(build.normalize_date('1/10/2568'), date(2025, 10, 1))
        self.assertEqual(build.normalize_date('28/2/2569'), date(2026, 2, 28))

    def test_iso_format_from_xlsx(self):
        self.assertEqual(build.normalize_date('2569-02-09 00:00:00'), date(2026, 2, 9))

    def test_gregorian_year_is_not_shifted(self):
        self.assertEqual(build.normalize_date('2026-02-09'), date(2026, 2, 9))

    def test_invalid_dates_are_rejected_not_guessed(self):
        for bad in ('', 'not-a-date', '32/13/2569', '9/2'):
            self.assertIsNone(build.normalize_date(bad), bad)


class MinuteTests(unittest.TestCase):
    def test_empty_and_zero_are_zero(self):
        for v in ('', '0', '00:00:00', None):
            self.assertEqual(build.parse_minutes(v), 0)

    def test_hms_and_hm(self):
        self.assertEqual(build.parse_minutes('00:04:00'), 4)
        self.assertEqual(build.parse_minutes('01:08:00'), 68)
        self.assertEqual(build.parse_minutes('02:06'), 126)


class ClassifyTests(unittest.TestCase):
    def test_holiday_from_status(self):
        c = build.classify(row(status='วันหยุด', cin='', cout='', remark='ขึ้นปีใหม่'),
                           HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'holiday')
        self.assertEqual(c['is_working_day'], 0)
        self.assertEqual(c['confidence'], 'DERIVED')

    def test_stated_absence_is_derived_not_inferred(self):
        c = build.classify(row(cin='', cout='', remark='ขาดงาน'), HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'absent')
        self.assertEqual(c['confidence'], 'DERIVED')
        self.assertIn('ABSENT_STATED_BY_SOURCE', c['flags'])

    def test_leave_maps_to_schema_enum(self):
        for remark, expected in (('ป่วย', 'sick'), ('กิจ', 'personal'), ('พักผ่อน', 'vacation')):
            c = build.classify(row(cin='', cout='', remark=remark), HEADER, HOLIDAYS, True, 2)
            self.assertEqual(c['attendance_status'], 'leave')
            self.assertEqual(c['leave_type'], expected, remark)

    def test_late_is_derived_and_counts_minutes(self):
        c = build.classify(row(late='00:04:00', remark='สาย'), HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'late')
        self.assertEqual(c['is_late'], 1)
        self.assertEqual(c['late_minutes'], 4)

    def test_present_without_late(self):
        c = build.classify(row(), HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'present')
        self.assertEqual(c['is_late'], 0)

    def test_official_duty_is_flagged_but_keeps_the_scan(self):
        c = build.classify(row(late='00:48:00', remark='งานรับปริญญา'), HEADER, HOLIDAYS, True, 2)
        self.assertIn('OFFICIAL_DUTY', c['flags'])
        self.assertEqual(c['classification'], 'official_duty')
        self.assertEqual(c['is_late'], 1, 'the raw scan must be preserved, not erased')

    def test_no_scan_workday_is_inferred_absent_and_flagged(self):
        c = build.classify(row(cin='', cout=''), HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'absent')
        self.assertEqual(c['confidence'], 'INFERRED')
        self.assertIn('ABSENT_INFERRED_NO_SCAN', c['flags'])

    def test_missing_check_out_is_flagged_not_absent(self):
        c = build.classify(row(cout=''), HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'present')
        self.assertIn('NO_SCAN_OUT', c['flags'])

    def test_weekend_is_not_a_working_day_when_status_column_is_absent(self):
        # 2025-10-04 is a Saturday; no status column in that header shape.
        c = build.classify(row_ns(when='4/10/2568', cin='', cout=''),
                           HEADER_NO_STATUS, HOLIDAYS, False, 5)
        self.assertEqual(c['attendance_status'], 'holiday')
        self.assertIn('WEEKEND_INFERRED', c['flags'])

    def test_labelled_holiday_is_not_a_working_day_when_status_is_absent(self):
        c = build.classify(row_ns(when='1/1/2569', cin='', cout='', remark='ขึ้นปีใหม่'),
                           HEADER_NO_STATUS, HOLIDAYS, False, 3)
        self.assertEqual(c['attendance_status'], 'holiday')

    def test_unknown_remark_on_a_workday_still_keeps_evidence(self):
        c = build.classify(row(cin='08:00:00', cout='17:00:00', remark='อะไรสักอย่าง'),
                           HEADER, HOLIDAYS, True, 2)
        self.assertEqual(c['attendance_status'], 'present')


class DdlTests(unittest.TestCase):
    def test_relaxed_ddl_only_relaxes_the_declared_columns(self):
        relaxed = rehearse.build_relaxed_ddl()
        for col in ('first_name_th', 'last_name_th', 'email', 'employee_type'):
            self.assertIn(col, relaxed)
        strict_email = 'email          TEXT NOT NULL UNIQUE'
        self.assertIn(strict_email, rehearse.DDL_STRICT)
        self.assertNotIn(strict_email, relaxed)

    def test_relaxed_ddl_keeps_other_not_null_columns(self):
        relaxed = rehearse.build_relaxed_ddl()
        self.assertIn('employee_uid   TEXT NOT NULL PRIMARY KEY', relaxed)
        self.assertIn('department     TEXT NOT NULL', relaxed)

    def test_ddl_has_no_invented_foreign_key_on_daily_attendance(self):
        block = rehearse.DDL_STRICT.split('CREATE TABLE daily_attendance (')[1].split(');')[0]
        self.assertNotIn('FOREIGN KEY', block,
                         'migration 004 declares no FK on daily_attendance; adding one would be an assumption')

    def test_relaxed_ddl_applies_to_sqlite(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(rehearse.build_relaxed_ddl())
        finally:
            conn.close()


class RehearsalUnitTests(unittest.TestCase):
    def test_rehearsal_uid_is_deterministic_and_distinct(self):
        a = rehearse.rehearsal_uid('1015')
        b = rehearse.rehearsal_uid('1015')
        c = rehearse.rehearsal_uid('1032')
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_identity_separation_survives_a_minimal_import(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(rehearse.build_relaxed_ddl())
            now = 'T'
            rows = [{'report_code': '1015', 'employee_code': '1015', 'employee_uid': 'u1',
                     'full_name_th': 'SYNTH A', 'department_current': 'UNIT',
                     'employment_status': 'resigned', 'device_code': '1015'},
                    {'report_code': '1032', 'employee_code': '1032', 'employee_uid': 'u2',
                     'full_name_th': 'SYNTH B', 'department_current': 'UNIT',
                     'employment_status': 'active', 'device_code': '1032'}]
            for r in rows:
                conn.execute(
                    'INSERT INTO employees (employee_uid, employee_id, first_name_th, last_name_th,'
                    ' email, department, employee_type, status, created_at, updated_at)'
                    ' VALUES (?,?,?,?,?,?,?,?,?,?)',
                    (rehearse.rehearsal_uid(r['report_code']), r['employee_code'],
                     r['full_name_th'], '', None, r['department_current'], 'university',
                     r['employment_status'], now, now))
            n = conn.execute('SELECT COUNT(*) FROM employees').fetchone()[0]
            self.assertEqual(n, 2)
            uids = {r[0] for r in conn.execute('SELECT employee_uid FROM employees')}
            self.assertEqual(len(uids), 2, '1015 and 1032 must never share a key')
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()
