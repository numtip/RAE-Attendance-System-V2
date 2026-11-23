-- HR-confirmed leave facts per employee: continuity of service (announcement clause 62), kind of appointment
-- (clause 23) and the HR decision on whether the person is inside the announcement's scope.
--
-- Why a separate table and not columns on employees: these values come from HR documents, must be traceable
-- (source, who confirmed, when) and are corrected through an audited import; employees carries identity and
-- sign-in data. employees.hire_date already exists and is NOT duplicated here.
--
-- NULL means "not known / not confirmed", never "none": the entitlement engine reads NULL as unknown.
-- eligibility_confirmed: 1 = inside the announcement, 0 = outside, NULL = HR has not decided (the engine keeps
-- needs_hr). A decision needs the reference of the document that records it.
--
-- Additive and idempotent. No existing table is altered and no row is written.
-- Rollback: database/rollbacks/034_employee_leave_profile.down.sql

CREATE TABLE IF NOT EXISTS employee_leave_profile (
  employee_uid VARCHAR(36) NOT NULL,
  continuous_service_start DATE NULL,
  appointment_kind ENUM('first', 'rehire_after_resignation', 'rehire_after_dismissal', 'other') NULL,
  eligibility_confirmed TINYINT(1) NULL,
  eligibility_reference VARCHAR(120) NULL,
  source_reference VARCHAR(255) NOT NULL,
  verified_by_uid VARCHAR(36) NOT NULL,
  verified_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (employee_uid),
  KEY idx_employee_leave_profile_verified_by (verified_by_uid),
  CONSTRAINT fk_employee_leave_profile_employee FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_employee_leave_profile_verifier FOREIGN KEY (verified_by_uid) REFERENCES employees (employee_uid),
  CONSTRAINT chk_employee_leave_profile_confirmation CHECK (
    eligibility_confirmed IS NULL OR (eligibility_reference IS NOT NULL AND eligibility_reference <> '')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
