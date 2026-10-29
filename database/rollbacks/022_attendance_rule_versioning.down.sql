-- Rollback for 022_attendance_rule_versioning.sql.
-- Drops the three Slice 2 rule tables. Any approved rule, holiday or schedule rows are dropped with them,
-- so export first if they carry real policy:  SELECT * FROM attendance_rule_version;
-- Order matters: attendance_schedule has an FK to employees, the other two have none, so any order works
-- for tables, but daily_attendance.rule_version_code / schedule_code (migration 023) are NOT foreign keys
-- and are deliberately left alone here - reverse 023 first if you want a fully clean database.
-- Idempotent: safe to run when part of the migration was already reversed.

DROP TABLE IF EXISTS attendance_schedule;
DROP TABLE IF EXISTS attendance_holiday;
DROP TABLE IF EXISTS attendance_rule_version;

-- Clearing the ledger row is part of the rollback (added 2026-10-29): the runner keys on the
-- filename, so without it `npm run db:migrate` believes this migration is still applied and the
-- schema stays partially rolled back.
DELETE FROM schema_migrations WHERE version = '022_attendance_rule_versioning.sql';
