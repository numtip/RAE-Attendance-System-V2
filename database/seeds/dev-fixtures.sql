-- Dev fixtures aligned with backend/src/dev/fixtures.js
-- Password for all seeded users: valid-pass
-- bcrypt (cost 8): $2b$08$XczTn.nUjHdw1jZXT14yQ.pZ5xOW/.DApc8Ut1z9a1BFi5KKCpT8G
-- Regenerate: node scripts/hash-dev-password.mjs

SET NAMES utf8mb4;

DELETE FROM daily_attendance;
DELETE FROM monthly_summary;
DELETE FROM employee_leave;
DELETE FROM leave_balance;
DELETE FROM employee_identifier;
DELETE FROM employees;

SET @seed_ts = '2026-01-15 08:00:00';

INSERT INTO employees (
  employee_uid, employee_id, first_name_th, last_name_th, email, password_hash,
  department, position, employee_type, status, role, locked_until, created_at, updated_at
) VALUES
  (
    '11111111-1111-1111-1111-111111111111', 'E-ADMIN', 'แอดมิน', 'ตัวอย่าง',
    'admin@example.test', '$2b$08$XczTn.nUjHdw1jZXT14yQ.pZ5xOW/.DApc8Ut1z9a1BFi5KKCpT8G',
    'สำนักงาน', 'ผู้ดูแล', 'university', 'active', 'admin', NULL, @seed_ts, @seed_ts
  ),
  (
    '22222222-2222-2222-2222-222222222222', 'E-USER', 'ผู้ใช้', 'ตัวอย่าง',
    'user@example.test', '$2b$08$XczTn.nUjHdw1jZXT14yQ.pZ5xOW/.DApc8Ut1z9a1BFi5KKCpT8G',
    'ภาควิชา', 'เจ้าหน้าที่', 'department', 'active', 'user', NULL, @seed_ts, @seed_ts
  ),
  (
    '33333333-3333-3333-3333-333333333333', 'E-LOCKED', 'ล็อก', 'ตัวอย่าง',
    'locked@example.test', '$2b$08$XczTn.nUjHdw1jZXT14yQ.pZ5xOW/.DApc8Ut1z9a1BFi5KKCpT8G',
    'ภาควิชา', 'เจ้าหน้าที่', 'contract', 'active', 'user', '2099-01-01 00:00:00', @seed_ts, @seed_ts
  );

INSERT INTO daily_attendance (
  employee_uid, date, check_in, check_out, is_late, late_minutes, work_duration,
  is_leave, status, created_at, updated_at
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  '2026-03-02',
  '2026-03-02 01:35:00',
  '2026-03-02 09:30:00',
  1, 5, 7.92,
  0, 'late', @seed_ts, @seed_ts
);

INSERT INTO monthly_summary (
  employee_uid, year, month, total_work_days, total_present, total_late, total_absent,
  total_leave, total_late_minutes, total_work_hours, created_at, updated_at
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  2026, 3, 22, 20, 1, 0, 1, 5, 160.00, @seed_ts, @seed_ts
);

INSERT INTO employee_leave (
  leave_id, employee_uid, leave_type, start_date, end_date, status, match_status,
  created_at, updated_at
) VALUES (
  'LV-1', '22222222-2222-2222-2222-222222222222', 'personal',
  '2026-03-10', '2026-03-10', 'approved', 'matched', @seed_ts, @seed_ts
);

INSERT INTO leave_balance (
  employee_uid, year, leave_type, total_days, used_days, remaining_days, created_at, updated_at
) VALUES (
  '22222222-2222-2222-2222-222222222222', 2026, 'personal', 6.00, 1.00, 5.00, @seed_ts, @seed_ts
);
