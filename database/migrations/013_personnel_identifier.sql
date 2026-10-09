-- SUPERSEDED (no-op, kept so schema_migrations history and ordering stay stable).
-- main's 013_employee_identifier_foundation.sql already adds ENUM value 'personnel_id' and
-- UNIQUE KEY uk_employee_identifier_type_value (id_type, id_value). Re-applying the old DDL here
-- would only duplicate it. Secure national_id lookup columns live in
-- 015_employee_identifier_secure_lookup.sql.
SELECT 1;
